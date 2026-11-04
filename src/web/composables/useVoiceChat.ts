/**
 * v3.7 语音连麦（WebRTC 点对点；服务器只转发 offer / answer / ice 信令）。
 *
 * 设计要点（与 useSound / useToast / useInteractionFx 同款「模块级单例」）：
 * - 状态只有一份：任何组件里 useVoiceChat() 拿到的都是同一组 ref；
 * - **room:state.voice 是唯一事实来源**：本地只「发起变更」（voice:state），
 *   `active` / `micMuted` / `peerActive` / `peerMicMuted` 一律由服务端回推后渲染，
 *   绝不本地先行改，避免和服务端不一致；
 * - 媒体直连，不经过服务器：本模块只负责 getUserMedia、RTCPeerConnection、
 *   远端流挂到 `#voice-audio`，以及把信令塞进 `voice:signal`；
 * - 协商用 MDN「perfect negotiation」：seat 'b' 为 polite 侧，双方同时发起也能收敛；
 * - 任何一步失败都只降级成 `status='failed'` + 可读文案，**绝不 throw、绝不阻塞对局**；
 * - 浏览器不支持（非安全上下文下 navigator.mediaDevices 不存在）→ supported=false，
 *   UI 整条隐藏，本模块不产生任何网络请求。
 */

import { computed, ref, watch } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import type { Socket } from 'socket.io-client';
import { VOICE_SIGNAL_KINDS, VOICE_SIGNAL_MAX_CHARS } from '@shared/protocol';
import type {
  ClientToServerEvents,
  PublicRoomState,
  Seat,
  ServerToClientEvents,
  VoiceRoomState,
  VoiceSignalKind,
  VoiceSignalPayload,
  VoiceStatePayload,
} from '@shared/protocol';
import { useGameSession } from './useGameSession';
import { useSocket } from './useSocket';
import type { SocketHandlers } from './useSocket';
import { useToast } from './useToast';

/** 语音连接状态。#voice-status 的文案由 statusText 派生（文案在 PROTOCOL.md §9 固定） */
export type VoiceChatStatus = 'idle' | 'connecting' | 'connected' | 'failed';

/**
 * 无 TURN / /rtc-config 不可用时的兜底 STUN。
 * 只做 NAT 穿透；P2P 打不通时降级为「语音连接失败，可继续打字」，游戏照常。
 */
const FALLBACK_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.miwifi.com:3478'] }],
};

/* ==================== 模块级单例状态 ==================== */

const status = ref<VoiceChatStatus>('idle');
/** 自己是否已加入语音（来自 room:state.voice.you.active） */
const active = ref(false);
/** 自己是否静音（来自 room:state.voice.you.micMuted） */
const micMuted = ref(false);
/** 对方是否已加入语音（来自 room:state.voice.opponent.active） */
const peerActive = ref(false);
/** 对方是否静音（来自 room:state.voice.opponent.micMuted） */
const peerMicMuted = ref(false);
/** 远端音频自动播放被浏览器拦下：UI 给「点我播放」按钮 */
const needsGesture = ref(false);

/**
 * 是否支持语音：必须有 RTCPeerConnection 且 navigator.mediaDevices.getUserMedia 可用。
 * 非 HTTPS 的局域网 IP 下 mediaDevices 为 undefined → false（UI 整条隐藏）。
 */
const supported = detectSupported();

/* ==================== 非响应式连接资源 ==================== */

let sock: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let pc: RTCPeerConnection | null = null;
/** openPc 正在进行中的 promise（并发调用复用同一次建连） */
let opening: Promise<void> | null = null;
let audioEl: HTMLAudioElement | null = null;
let localStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;

/** 自己是否在语音里（本地意图；active 的展示仍以服务端为准） */
let joined = false;
/** 静音的本地意图：重连后重新 voice:state 时要用 */
let wantedMuted = false;
/** start() 的序号：stop() 会让在途的 start() 自行作废 */
let startSeq = 0;

/* perfect negotiation 的本地标志（MDN 同款） */
let polite = false;
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;
/** 在 setRemoteDescription 之前到达的 ICE candidate 先排队 */
let pendingCandidates: RTCIceCandidateInit[] = [];

/** 失败重建次数（connected 时清零；超过上限就停在 failed，等用户手动重开） */
let recoveries = 0;
let recovering = false;
/** 本轮「disconnected」是否已经试过 ICE 重启（connected / 建新 PC 时复位） */
let iceRestartTried = false;
let failToastShown = false;
/** 「对方开启了语音，点麦克风加入」的提示节流（避免每次重协商都弹） */
let joinHintAt = 0;
/** 静音上报在途：连点两下不重复发状态，避免和服务端来回打架 */
let mutePending = false;

/* ==================== 纯函数助手 ==================== */

function detectSupported(): boolean {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (typeof window.RTCPeerConnection !== 'function') return false;
    const media = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    return !!media && typeof media.getUserMedia === 'function';
  } catch {
    return false;
  }
}

function getMediaDevices(): MediaDevices | null {
  try {
    const media = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    return media && typeof media.getUserMedia === 'function' ? media : null;
  } catch {
    return null;
  }
}

/** 把 getUserMedia 的异常翻译成玩家能看懂的一句话（不抛错） */
function micErrorText(err: unknown): string {
  const name =
    err && typeof err === 'object' ? String((err as { name?: unknown }).name || '') : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return '麦克风被拒绝，允许授权后可以再点一次';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没找到麦克风，插一个设备再试';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被别的程序占用了，可以继续文字对局';
  }
  return '拿不到麦克风，可以继续文字对局';
}

/**
 * 读取 room:state.voice（守护旧服务端：字段缺失按 disabled 处理，任何情况下不抛错）。
 */
function readVoiceState(next: PublicRoomState | null | undefined): VoiceRoomState | null {
  if (!next || typeof next !== 'object') return null;
  const raw = (next as unknown as { voice?: unknown }).voice;
  if (!raw || typeof raw !== 'object') return null;
  return raw as VoiceRoomState;
}

function readPlayerVoice(
  voice: VoiceRoomState | null,
  side: 'you' | 'opponent',
): { active: boolean; micMuted: boolean } {
  if (!voice) return { active: false, micMuted: false };
  const raw = (voice as unknown as Record<string, unknown>)[side];
  if (!raw || typeof raw !== 'object') return { active: false, micMuted: false };
  const player = raw as { active?: unknown; micMuted?: unknown };
  return { active: !!player.active, micMuted: !!player.micMuted };
}

function readSignal(raw: unknown): VoiceSignalPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  const data = (raw as { data?: unknown }).data;
  if (typeof kind !== 'string' || !(VOICE_SIGNAL_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof data !== 'string' || data.length > VOICE_SIGNAL_MAX_CHARS) return null;
  return { kind: kind as VoiceSignalKind, data };
}

/** 解析对手发来的 ICE candidate（'' = 结束候选，直接忽略） */
function parseCandidate(raw: string): RTCIceCandidateInit | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const init = parsed as RTCIceCandidateInit;
    if (typeof init.candidate !== 'string') return null;
    return init;
  } catch {
    return null;
  }
}

function isIceServerUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return (
    lower.startsWith('stun:') ||
    lower.startsWith('stuns:') ||
    lower.startsWith('turn:') ||
    lower.startsWith('turns:')
  );
}

/** 校验 /rtc-config 的响应；格式不对的条目直接丢，一条都不剩时走兜底 */
function normalizeIceServers(raw: unknown): RTCIceServer[] {
  const list = raw && typeof raw === 'object' ? (raw as { iceServers?: unknown }).iceServers : null;
  if (!Array.isArray(list)) return [];
  const servers: RTCIceServer[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const urlsRaw = (item as { urls?: unknown }).urls;
    const candidates = Array.isArray(urlsRaw)
      ? urlsRaw
      : typeof urlsRaw === 'string'
        ? [urlsRaw]
        : [];
    const urls = candidates.filter(
      (url): url is string => typeof url === 'string' && url.trim().length > 0 && isIceServerUrl(url),
    );
    if (!urls.length) continue;
    const server: RTCIceServer = { urls };
    const username = (item as { username?: unknown }).username;
    const credential = (item as { credential?: unknown }).credential;
    if (typeof username === 'string' && username) server.username = username;
    if (typeof credential === 'string' && credential) server.credential = credential;
    servers.push(server);
  }
  return servers;
}

/** GET /rtc-config（Cache-Control: no-store）；失败或格式不对 → STUN 兜底，绝不 throw */
async function loadIceConfig(): Promise<RTCConfiguration> {
  try {
    const res = await fetch('/rtc-config', { cache: 'no-store' });
    if (!res || !res.ok) return FALLBACK_RTC_CONFIG;
    const data = (await res.json()) as unknown;
    const servers = normalizeIceServers(data);
    if (!servers.length) return FALLBACK_RTC_CONFIG;
    return { iceServers: servers };
  } catch {
    return FALLBACK_RTC_CONFIG;
  }
}

/* ==================== 媒体 / PC 生命周期助手（模块级） ==================== */

function findAudioEl(): HTMLAudioElement | null {
  try {
    if (audioEl && audioEl.isConnected) return audioEl;
    const found = document.getElementById('voice-audio');
    audioEl = found instanceof HTMLAudioElement ? found : null;
    return audioEl;
  } catch {
    return null;
  }
}

/** 播放远端音频；被自动播放策略拦下时置 needsGesture，交给 UI 的「点我播放」 */
function playRemoteAudio(el: HTMLAudioElement): void {
  try {
    const pending = el.play();
    if (!pending || typeof pending.then !== 'function') {
      needsGesture.value = false;
      return;
    }
    pending.then(
      () => {
        needsGesture.value = false;
      },
      () => {
        needsGesture.value = true;
      },
    );
  } catch {
    needsGesture.value = true;
  }
}

function attachRemoteAudio(): void {
  const el = findAudioEl();
  if (!el || !remoteStream) return;
  try {
    if (el.srcObject !== remoteStream) el.srcObject = remoteStream;
  } catch {
    /* srcObject 赋值失败不影响对局 */
  }
  playRemoteAudio(el);
}

function clearRemoteAudio(): void {
  remoteStream = null;
  const el = findAudioEl();
  if (!el) return;
  try {
    el.pause();
  } catch {
    /* ignore */
  }
  try {
    el.srcObject = null;
  } catch {
    /* ignore */
  }
}

function stopLocalStream(): void {
  const stream = localStream;
  localStream = null;
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

function setLocalTracksEnabled(on: boolean): void {
  if (!localStream) return;
  for (const track of localStream.getAudioTracks()) {
    try {
      track.enabled = on;
    } catch {
      /* ignore */
    }
  }
}

/** 关掉 PC 并解绑所有回调；不清本地麦克风、不清远端流（由 stop()/openPc() 决定） */
function resetConnection(): void {
  const conn = pc;
  pc = null;
  pendingCandidates = [];
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;
  iceRestartTried = false;
  if (!conn) return;
  try {
    conn.onnegotiationneeded = null;
    conn.onicecandidate = null;
    conn.ontrack = null;
    conn.onconnectionstatechange = null;
    conn.onsignalingstatechange = null;
  } catch {
    /* ignore */
  }
  try {
    conn.close();
  } catch {
    /* ignore */
  }
}

async function addCandidate(init: RTCIceCandidateInit): Promise<void> {
  const conn = pc;
  if (!conn || !conn.remoteDescription) {
    pendingCandidates.push(init);
    return;
  }
  try {
    await conn.addIceCandidate(init);
  } catch {
    /* 已过期 / 乱序的 candidate 属于可忽略异常 */
  }
}

async function flushPendingCandidates(): Promise<void> {
  const conn = pc;
  if (!conn || !conn.remoteDescription) return;
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const init of queued) {
    await addCandidate(init);
  }
}

/* ==================== 对外 API ==================== */

export interface VoiceChatApi {
  /** 浏览器是否支持语音（不支持时 UI 整条隐藏） */
  supported: boolean;
  status: Ref<VoiceChatStatus>;
  /** #voice-status 的固定文案 */
  statusText: ComputedRef<string>;
  active: Ref<boolean>;
  micMuted: Ref<boolean>;
  peerActive: Ref<boolean>;
  peerMicMuted: Ref<boolean>;
  needsGesture: Ref<boolean>;
  /** 是否已在房间里（room:state 存在） */
  inRoom: ComputedRef<boolean>;
  /** 本房间是否开启语音（state.voice.enabled，旧服务端按 false） */
  enabled: ComputedRef<boolean>;
  /** 用户手势内调用：拿麦克风 + 通知服务器 + 与对手建连 */
  start(): Promise<void>;
  /** 彻底退出语音：关 PC、停 track、清远端流、通知服务器 active=false */
  stop(): void;
  toggleMute(): void;
  /** 自动播放被拦下后，由用户手势恢复播放 */
  resumeAudio(): void;
  /** 音频元素挂载后把已收到的远端流补挂上去（VoiceBar onMounted 调用） */
  syncAudio(): void;
}

/* 交给 useSocket.ensureSocket 的占位回调：调用时机保证 socket 已由 useGameSession 建好，
   真实回调早已注册，这里的对象不会生效（ensureSocket 对已存在的 socket 直接返回）。 */
const ATTACH_HANDLERS: SocketHandlers = {
  onConnect() {},
  onDisconnect() {},
  onConnectError() {},
  onState() {},
  onCountdown() {},
  onRoundOpen() {},
  onOpponentSubmitted() {},
  onReveal() {},
  onNotice() {},
  onInteracted() {},
  onRoomError() {},
};

function createVoiceChat(): VoiceChatApi {
  const socketApi = useSocket();
  const toastApi = useToast();
  const game = useGameSession();

  /* ---------------- 与 useSocket 的挂接 ---------------- */

  /**
   * 只从已存在的 socket 上订阅（voice:signal / connect）。
   * 用 isConnected() 兜底：true 说明 useGameSession.init() 早已 ensureSocket 过，
   * 这里再调用只是取回同一个实例，绝不会顶掉游戏回调。
   */
  function attachSocket(): void {
    if (sock || !supported) return;
    if (!socketApi.isConnected()) return;
    try {
      sock = socketApi.ensureSocket(ATTACH_HANDLERS);
      sock.on('voice:signal', onSignalEvent);
      sock.on('connect', onSocketConnect);
    } catch {
      sock = null;
    }
  }

  /* ---------------- 信令 / 状态上报 ---------------- */

  /** voice:signal 只是转发：delivered=false 不重发（ICE 候选本身冗余，且服务端不排队） */
  function sendSignal(kind: VoiceSignalKind, data: string): void {
    if (!joined || typeof data !== 'string') return;
    if (data.length > VOICE_SIGNAL_MAX_CHARS) return;
    try {
      socketApi.emitAck('voice:signal', { kind, data }, () => {
        /* 未送达由后续协商/连接状态兜底 */
      });
    } catch {
      /* 信令失败不落地 */
    }
  }

  /** voice:state 上报；quiet 用于重连后自动补发（不打扰玩家） */
  function announceState(patch: VoiceStatePayload, quiet = false): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        socketApi.emitAck('voice:state', patch, (res) => {
          if (res.ok) {
            done(true);
            return;
          }
          if (!quiet) {
            if (res.error === 'VOICE_DISABLED') toastApi.toast('这个房间没开启语音');
            else if (res.error === 'OFFLINE') toastApi.toast('还没连上服务器，语音稍后再试');
            else if (res.error === 'TIMEOUT') toastApi.toast('服务器没回应，语音先算了');
            else toastApi.toast(res.message || '语音状态没同步上');
          }
          done(false);
        });
      } catch {
        done(false);
      }
    });
  }

  /* ---------------- 协商（perfect negotiation） ---------------- */

  async function negotiate(): Promise<void> {
    const conn = pc;
    if (!conn || !joined || makingOffer) return;
    try {
      makingOffer = true;
      const offer = await conn.createOffer();
      if (pc !== conn || !joined) return;
      await conn.setLocalDescription(offer);
      const sdp = conn.localDescription ? conn.localDescription.sdp : offer.sdp || '';
      if (sdp) sendSignal('offer', sdp);
    } catch {
      // 协商失败交给 connectionState 兜底（failed → recoverConnection）
    } finally {
      makingOffer = false;
    }
  }

  async function openPc(): Promise<void> {
    if (!joined || pc) return;
    if (opening) {
      await opening;
      return;
    }
    opening = (async (): Promise<void> => {
      const stream = localStream;
      if (!stream) return;
      // polite 侧（seat 'b'）在 glare 时回滚自己、接受对方的 offer
      polite = currentSeat() === 'b';
      const config = await loadIceConfig();
      if (!joined || pc || !localStream) return;
      const Ctor = window.RTCPeerConnection;
      if (typeof Ctor !== 'function') throw new Error('RTCPeerConnection unavailable');
      const conn = new Ctor(config);
      pc = conn;
      conn.onnegotiationneeded = () => {
        void negotiate();
      };
      conn.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (pc !== conn || !joined) return;
        const candidate = event && event.candidate ? event.candidate : null;
        sendSignal('ice', candidate ? JSON.stringify(candidate) : '');
      };
      conn.ontrack = (event: RTCTrackEvent) => {
        try {
          const incoming =
            event.streams && event.streams[0]
              ? event.streams[0]
              : new MediaStream([event.track]);
          remoteStream = incoming;
          attachRemoteAudio();
        } catch {
          /* 远端流挂载失败不影响对局 */
        }
      };
      conn.onconnectionstatechange = () => {
        handleConnectionState(conn);
      };
      conn.onsignalingstatechange = () => {
        if (conn === pc && conn.signalingState === 'stable') void flushPendingCandidates();
      };
      const tracks = stream.getAudioTracks();
      if (tracks.length) {
        for (const track of tracks) {
          try {
            conn.addTrack(track, stream);
          } catch {
            /* 单条 track 失败不阻塞其余 */
          }
        }
      } else {
        try {
          conn.addTransceiver('audio', { direction: 'recvonly' });
        } catch {
          /* ignore */
        }
      }
      status.value = 'connecting';
      attachRemoteAudio();
    })();
    try {
      await opening;
    } finally {
      opening = null;
    }
  }

  /** 双方都在语音里时才需要建连；已建有 PC 就按状态补一次协商 */
  async function ensureConnected(): Promise<void> {
    if (!joined || !localStream) return;
    try {
      if (!pc) {
        await openPc();
        return;
      }
      if (pc.connectionState === 'failed') {
        await recoverConnection();
        return;
      }
      if (pc.signalingState === 'stable' && !pc.remoteDescription) await negotiate();
    } catch {
      /* 建连失败交给状态机兜底 */
    }
  }

  function handleConnectionState(conn: RTCPeerConnection): void {
    if (conn !== pc) return;
    try {
      const state = conn.connectionState;
      if (state === 'connected') {
        status.value = 'connected';
        recoveries = 0;
        iceRestartTried = false;
        attachRemoteAudio();
        return;
      }
      if (state === 'failed') {
        void recoverConnection();
        return;
      }
      if (state === 'disconnected') {
        if (status.value === 'connected') status.value = 'connecting';
        // 先试最便宜的恢复：ICE 重启（会触发 negotiationneeded → 新 offer）
        if (!iceRestartTried) {
          iceRestartTried = true;
          try {
            conn.restartIce();
          } catch {
            /* 重启失败也无所谓，等 failed 走重建 */
          }
        }
        return;
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 连接失败的自愈：重建 PC 并补发 voice:state active=true
   * （服务端不保存 SDP / candidate，重建是对齐双方状态的唯一办法）。
   * 连续失败超过上限就停在 failed，让玩家继续文字对局。
   */
  async function recoverConnection(): Promise<void> {
    if (!joined) {
      status.value = 'failed';
      return;
    }
    if (recovering) return;
    recovering = true;
    recoveries += 1;
    try {
      if (recoveries > 3) {
        resetConnection();
        status.value = 'failed';
        if (!failToastShown) {
          failToastShown = true;
          toastApi.toast('语音没连上，可以继续打字对局');
        }
        return;
      }
      resetConnection();
      status.value = 'connecting';
      void announceState({ active: true, micMuted: wantedMuted }, true);
      if (peerActive.value) await ensureConnected();
    } finally {
      recovering = false;
    }
  }

  /* ---------------- 收到对手信令 ---------------- */

  function onSignalEvent(payload: VoiceSignalPayload): void {
    void handleSignal(payload).catch(() => {
      /* 信令处理失败不落地 */
    });
  }

  /** 自己还没加入语音时的提示（8s 内只提示一次，避免重协商刷屏） */
  function hintJoinVoice(): void {
    const now = Date.now();
    if (now - joinHintAt < 8000) return;
    joinHintAt = now;
    toastApi.toast('对方开启了语音，点麦克风加入');
  }

  async function handleSignal(raw: unknown): Promise<void> {
    const signal = readSignal(raw);
    if (!signal) return;
    if (!joined) {
      // 自己还没加入语音：绝不自动开麦，只提示一下
      if (signal.kind !== 'ice') hintJoinVoice();
      return;
    }
    attachSocket();
    try {
      if (signal.kind === 'ice') {
        const init = parseCandidate(signal.data);
        if (!init) return;
        await addCandidate(init);
        return;
      }
      if (!pc) await ensureConnected();
      const conn = pc;
      if (!conn) return;
      const description: RTCSessionDescriptionInit = { type: signal.kind, sdp: signal.data };
      const readyForOffer =
        !makingOffer && (conn.signalingState === 'stable' || isSettingRemoteAnswerPending);
      const offerCollision = signal.kind === 'offer' && !readyForOffer;
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;
      isSettingRemoteAnswerPending = signal.kind === 'answer';
      await conn.setRemoteDescription(description);
      isSettingRemoteAnswerPending = false;
      if (signal.kind === 'offer') {
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        const sdp = conn.localDescription ? conn.localDescription.sdp : answer.sdp || '';
        if (sdp) sendSignal('answer', sdp);
      }
      await flushPendingCandidates();
    } catch {
      isSettingRemoteAnswerPending = false;
      // 过期 candidate / 状态竞争属于可忽略异常；offer / answer 失败才走自愈
      if (signal.kind !== 'ice') {
        status.value = 'connecting';
        void recoverConnection();
      }
    }
  }

  /* ---------------- socket 生命周期 ---------------- */

  function onSocketConnect(): void {
    try {
      if (!joined) return;
      // 重连后服务器已把语音元状态复位；旧 PC 的 SDP / candidate 全部作废，重建再协商
      resetConnection();
      recoveries = 0;
      failToastShown = false;
      status.value = 'connecting';
      void announceState({ active: true, micMuted: wantedMuted }, true);
      if (peerActive.value) void ensureConnected();
    } catch {
      /* ignore */
    }
  }

  /* ---------------- room:state → 本地展示 + 生命周期 ---------------- */

  function currentSeat(): Seat {
    try {
      const st = game.state;
      if (st && st.you && (st.you.seat === 'a' || st.you.seat === 'b')) return st.you.seat;
      const sess = game.session;
      if (sess && (sess.seat === 'a' || sess.seat === 'b')) return sess.seat;
    } catch {
      /* ignore */
    }
    return 'a';
  }

  function resetDisplay(): void {
    status.value = 'idle';
    needsGesture.value = false;
    active.value = false;
    micMuted.value = false;
    peerActive.value = false;
    peerMicMuted.value = false;
  }

  function handleRoomState(next: PublicRoomState | null): void {
    if (!supported) return;
    try {
      attachSocket();

      // 不在房间 / 房间没了：彻底清干净
      if (!next) {
        if (joined) stop();
        else resetDisplay();
        return;
      }

      const voice = readVoiceState(next);
      // 旧服务端没有 voice 字段，或本房间没开语音：按 disabled 处理
      if (!voice || voice.enabled !== true) {
        if (joined) stop();
        else resetDisplay();
        return;
      }

      const you = readPlayerVoice(voice, 'you');
      const opponent = readPlayerVoice(voice, 'opponent');
      const wasPeerActive = peerActive.value;

      // 展示态一律以服务端为唯一事实来源
      active.value = joined && you.active;
      micMuted.value = joined && you.micMuted;
      peerActive.value = opponent.active;
      peerMicMuted.value = opponent.micMuted;
      if (!needsGesture.value && status.value === 'idle' && joined) status.value = 'connecting';

      // 重连后服务端把 you.active 复位为 false：本地还握着麦克风就自动补报（不打扰玩家）
      if (joined && !you.active) {
        void announceState({ active: true, micMuted: wantedMuted }, true);
      }

      if (!joined) return;

      if (opponent.active && !wasPeerActive) {
        // 对方刚加入语音：建连 + 重新协商
        void ensureConnected();
      } else if (!opponent.active && wasPeerActive) {
        // 对方退出语音：关掉旧 PC / 清远端流，等对方回来再重新协商（本地麦克风保留）
        resetConnection();
        clearRemoteAudio();
        status.value = 'connecting';
      }
      // 对方静音（opponent.micMuted）只是文案提示，不需要重新协商
    } catch {
      /* 守卫：任何异常都不能影响对局 */
    }
  }

  /* ---------------- 对外动作 ---------------- */

  async function start(): Promise<void> {
    if (!supported || joined) return;
    const seq = ++startSeq;
    status.value = 'connecting';
    needsGesture.value = false;
    failToastShown = false;
    recoveries = 0;
    try {
      attachSocket();
      const media = getMediaDevices();
      if (!media) {
        status.value = 'failed';
        toastApi.toast('这个浏览器不支持语音连麦，可以继续文字对局');
        return;
      }
      // 必须在用户手势内先拿麦克风：await 之前不做任何其它异步操作
      let stream: MediaStream;
      try {
        stream = await media.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        if (seq !== startSeq) return;
        status.value = 'failed';
        toastApi.toast(micErrorText(err));
        return;
      }
      if (seq !== startSeq) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      localStream = stream;
      wantedMuted = false;
      setLocalTracksEnabled(true);
      joined = true;
      const ok = await announceState({ active: true, micMuted: false });
      if (seq !== startSeq || !joined) return;
      if (!ok) {
        joined = false;
        resetConnection();
        stopLocalStream();
        status.value = 'failed';
        return;
      }
      if (peerActive.value) void ensureConnected();
    } catch {
      if (seq === startSeq) {
        joined = false;
        resetConnection();
        stopLocalStream();
        status.value = 'failed';
      }
    }
  }

  function stop(): void {
    startSeq += 1;
    const wasJoined = joined;
    joined = false;
    wantedMuted = false;
    recoveries = 0;
    failToastShown = false;
    resetConnection();
    stopLocalStream();
    clearRemoteAudio();
    status.value = 'idle';
    needsGesture.value = false;
    active.value = false;
    micMuted.value = false;
    if (wasJoined) void announceState({ active: false, micMuted: false }, true);
  }

  function toggleMute(): void {
    if (!joined || mutePending) return;
    const next = !micMuted.value;
    wantedMuted = next;
    setLocalTracksEnabled(!next);
    mutePending = true;
    void announceState({ micMuted: next }).then((ok) => {
      mutePending = false;
      if (ok) return;
      // 服务器没接受 → 本地轨道回到服务端状态，保持「以服务端为准」
      wantedMuted = micMuted.value;
      setLocalTracksEnabled(!micMuted.value);
    });
  }

  function resumeAudio(): void {
    const el = findAudioEl();
    if (!el) {
      needsGesture.value = false;
      return;
    }
    if (remoteStream) attachRemoteAudio();
    else playRemoteAudio(el);
  }

  function syncAudio(): void {
    attachRemoteAudio();
  }

  /* ---------------- 派生文案 / 可见性 ---------------- */

  const inRoom = computed<boolean>(() => !!game.state);

  const enabled = computed<boolean>(() => {
    const voice = readVoiceState(game.state);
    return !!voice && voice.enabled === true;
  });

  const statusText = computed<string>(() => {
    if (status.value === 'connecting') return '语音连接中…';
    if (status.value === 'connected') {
      return peerMicMuted.value ? '语音已连接（对方已静音）' : '语音已连接';
    }
    if (status.value === 'failed') return '语音连接失败，可继续打字';
    // idle：对方开了就等自己加入，否则等对方
    return peerActive.value ? '未开启语音' : '等对方开启语音';
  });

  // room:state 是唯一事实来源：每次服务端广播都同步展示态并驱动协商
  watch(
    () => game.state,
    (next) => {
      handleRoomState(next);
    },
    { immediate: true },
  );

  return {
    supported,
    status,
    statusText,
    active,
    micMuted,
    peerActive,
    peerMicMuted,
    needsGesture,
    inRoom,
    enabled,
    start,
    stop,
    toggleMute,
    resumeAudio,
    syncAudio,
  };
}

let api: VoiceChatApi | null = null;

/** 唯一出口：整个应用共享同一份语音状态（与 useGameSession / useSound 同款单例） */
export function useVoiceChat(): VoiceChatApi {
  if (!api) api = createVoiceChat();
  return api;
}
