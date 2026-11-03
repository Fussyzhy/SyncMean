/**
 * 管理后台 socket 封装（单例组合式，PROTOCOL.md §14）。
 *
 * 设计要点：
 * - 与玩家连接完全隔离：独立 namespace `/admin`（ADMIN_NAMESPACE），握手 `auth: { key }`；
 *   管理员 socket 永远不 join 任何房间频道，观战 / 终止都不会影响玩家对局协议。
 * - 密钥只存 sessionStorage['321:admin-key']（刷新免重输、关标签页即失效），
 *   禁止写 localStorage / URL / DOM / 日志。
 * - 状态机：idle（未登录）→ connecting（握手鉴权中）→ authed（面板可用）；
 *   鉴权失败 / 限流回门禁并给出中文原因，运行中断线则保留面板（#admin-status 显示「已断线」），
 *   等 socket.io 自动重连后自动重拉列表并恢复观战。
 * - ack 一律走 emitAck（10s 超时兜底；成功失败都归位 loading，规则同 PROTOCOL §12）。
 * - 倒计时统一换算成「服务端时钟」：用载荷里的 `at` 与本地接收时刻求偏移，
 *   再配本地 100ms ticker 展示剩余时间，避免手机 / 服务器时钟不一致。
 */

import { computed, reactive, ref } from 'vue';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  ADMIN_AUTH_ERROR,
  ADMIN_NAMESPACE,
  ADMIN_RATE_LIMIT_ERROR,
  type AdminClientToServerEvents,
  type AdminHandshakeAuth,
  type AdminRoomClosedPayload,
  type AdminRoomDetail,
  type AdminRoomStatePayload,
  type AdminRoomSummary,
  type AdminRoomsPayload,
  type AdminServerToClientEvents,
} from '@shared/admin';
import type { Ack, ActionResult, Phase } from '@shared/protocol';
import { formatClock } from '@/lib/format';
import { loadAdminKey, saveAdminKey } from '@/lib/storage';
import { useToast } from './useToast';

const ACK_TIMEOUT_MS = 10000;
/** 终止房间的二次确认窗口（与玩家端「结束本局」一致，PROTOCOL §12） */
const DELETE_CONFIRM_MS = 4000;

type AdminSocket = Socket<AdminServerToClientEvents, AdminClientToServerEvents>;

export type AdminStatus = 'idle' | 'connecting' | 'authed' | 'error';
export type AdminView = 'gate' | 'panel';
export type AdminClosedReason = '' | 'deleted' | 'expired';

export type AdminClientFailureCode = 'OFFLINE' | 'TIMEOUT' | 'BAD_ACK' | 'EMIT_FAILED';

/** 纯客户端失败（未连接 / 超时 / 协议异常），error 不属于服务端 ErrorCode */
export interface AdminClientFailure {
  ok: false;
  error: AdminClientFailureCode;
  message: string;
}

export type AdminAckOutcome<T> = ActionResult<T> | AdminClientFailure;

/** 从事件签名里抽出 ack 的结果类型 */
type AckResultOf<E extends keyof AdminClientToServerEvents> = NonNullable<
  Parameters<AdminClientToServerEvents[E]>[1]
> extends Ack<infer T>
  ? T
  : never;

/** 从事件签名里抽出请求载荷类型 */
type PayloadOf<E extends keyof AdminClientToServerEvents> = Parameters<
  AdminClientToServerEvents[E]
>[0];

/** 相位中文文案；结算快照挂起时由 phaseText() 覆盖成「结算中」 */
const PHASE_TEXT: Record<Phase, string> = {
  lobby: '等待中',
  countdown: '倒计时',
  submitting: '填词中',
  reveal: '揭晓',
  won: '通关',
  aborted: '已中止',
};

/** 服务端时钟基准：`at` = 服务端生成载荷的时刻，`recvAt` = 本地收到它的时刻 */
interface ClockSample {
  at: number;
  recvAt: number;
}

const EMPTY_CLOCK: ClockSample = { at: 0, recvAt: 0 };

/** 等待时长文案：刚刚 / N 秒 / N 分 N 秒 / N 小时 N 分 */
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分 ' + (seconds % 60) + ' 秒';
  const hours = Math.floor(minutes / 60);
  return hours + ' 小时 ' + (minutes % 60) + ' 分';
}

/** 填词时限文案（0 = 不限时） */
function limitText(ms: number): string {
  const safe = Number(ms);
  if (!Number.isFinite(safe) || safe <= 0) return '不限时';
  if (safe % 60000 === 0) return safe / 60000 + ' 分钟';
  return Math.round(safe / 1000) + ' 秒';
}

function createAdminSession() {
  const toastApi = useToast();

  /* ---------------- 状态 ---------------- */

  const view = ref<AdminView>('gate');
  const status = ref<AdminStatus>('idle');
  /** 门禁错误文案（密钥错误 / 限流 / 未配置 / 断网都落在这里） */
  const gateError = ref('');
  /** 上次成功登录记住的密钥（仅用于门禁预填，真值仍在 sessionStorage） */
  const rememberedKey = ref(loadAdminKey());

  const rooms = ref<AdminRoomSummary[]>([]);
  const totalRooms = ref(0);
  const totalPlayers = ref(0);
  const roomsClock = ref<ClockSample>(EMPTY_CLOCK);

  const selectedCode = ref('');
  const detail = ref<AdminRoomDetail | null>(null);
  const detailClock = ref<ClockSample>(EMPTY_CLOCK);
  const closedReason = ref<AdminClosedReason>('');

  const now = ref(Date.now());
  const refreshing = ref(false);
  const watching = ref(false);

  /** 正在终止的房间码（空串 = 没有进行中的终止请求） */
  const deletePending = ref('');
  /** 4s 二次确认：第一次点击记录房间码与截止时刻，再点才真正 emit */
  const deleteConfirmCode = ref('');
  const deleteConfirmUntil = ref(0);

  /** socket 与当前密钥放在闭包里，不暴露给 UI */
  let socket: AdminSocket | null = null;
  let currentKey = '';
  let initialized = false;

  /* ---------------- 派生 ---------------- */

  const gateBusy = computed(() => status.value === 'connecting');

  const statusText = computed(() => {
    if (status.value === 'authed') return '已连接';
    if (status.value === 'connecting') return '连接中…';
    return '已断线';
  });

  const hasRooms = computed(() => rooms.value.length > 0);

  const detailCountdown = computed(() => {
    if (closedReason.value) return '观战已结束';
    if (!detail.value) return '';
    return countdownTextFor(detail.value, detailClock.value);
  });

  const closedText = computed(() => {
    if (closedReason.value === 'deleted') return '房间已被管理员关闭，观战结束。';
    if (closedReason.value === 'expired') return '房间已不存在或已结束，观战结束。';
    return '';
  });

  /* ---------------- 时钟 / 文案工具 ---------------- */

  /** 服务端「现在」≈ 本地 now +（载荷生成时刻 − 本地收到时刻） */
  function serverNow(clock: ClockSample): number {
    if (!clock.at || !clock.recvAt) return now.value;
    return now.value + (clock.at - clock.recvAt);
  }

  function remainingMs(
    deadline: number | null | undefined,
    clock: ClockSample,
  ): number | null {
    if (deadline === null || deadline === undefined || !Number.isFinite(deadline)) return null;
    return deadline - serverNow(clock);
  }

  /** 列表 / 详情共用的倒计时文案（本地 100ms ticker 触发重算） */
  function countdownTextFor(
    room: AdminRoomSummary | AdminRoomDetail,
    clock: ClockSample,
  ): string {
    if (room.settlePending) return '结算中';
    switch (room.phase) {
      case 'lobby':
        return '等待准备';
      case 'countdown': {
        const left = remainingMs(room.deadline, clock);
        if (left === null || left <= 0) return '即将开始';
        return Math.ceil(left / 1000) + ' 秒后开始';
      }
      case 'submitting': {
        if (!room.submitLimitMs || room.submitLimitMs <= 0) return '不限时';
        const left = remainingMs(room.deadline, clock);
        if (left === null) return '不限时';
        if (left <= 0) return '超时结算中';
        return formatClock(left) + ' 剩余';
      }
      case 'reveal':
        return '等待下一轮';
      case 'won':
        return '已通关';
      case 'aborted':
        return '已中止';
      default:
        return '—';
    }
  }

  /** 相位中文名（结算快照挂起优先显示「结算中」） */
  function phaseText(room: AdminRoomSummary | AdminRoomDetail | null | undefined): string {
    if (!room) return '';
    if (room.settlePending) return '结算中';
    return PHASE_TEXT[room.phase] || '未知';
  }

  /** 房间列表卡片的倒计时（服务端时钟基准） */
  function countdownText(room: AdminRoomSummary): string {
    return countdownTextFor(room, roomsClock.value);
  }

  /** 房间已等待时长（从 createdAt 起算的服务端时钟） */
  function waitingText(room: AdminRoomSummary): string {
    const created = Number(room.createdAt);
    if (!Number.isFinite(created) || created <= 0) return '—';
    return elapsedText(Math.max(0, serverNow(roomsClock.value) - created));
  }

  /** 房间级填词时限文案 */
  function submitLimitText(room: AdminRoomSummary): string {
    return limitText(room.submitLimitMs);
  }

  /* ---------------- 数据应用 ---------------- */

  function applyRooms(payload: AdminRoomsPayload | null | undefined): void {
    const list = payload && Array.isArray(payload.rooms) ? payload.rooms : [];
    rooms.value = list;
    const totalRoomValue = Number(payload && payload.totalRooms);
    totalRooms.value = Number.isFinite(totalRoomValue) ? totalRoomValue : list.length;
    const totalPlayerValue = Number(payload && payload.totalPlayers);
    totalPlayers.value = Number.isFinite(totalPlayerValue)
      ? totalPlayerValue
      : list.reduce((sum, room) => sum + (Number(room.playerCount) || 0), 0);
    roomsClock.value = {
      at: Number(payload && payload.at) || 0,
      recvAt: Date.now(),
    };
  }

  /** 观战快照应用：详情没有独立的服务端时间戳，沿用最近一次列表载荷的时钟 */
  function applyDetail(code: string, next: AdminRoomDetail): void {
    selectedCode.value = code;
    detail.value = next;
    closedReason.value = '';
    detailClock.value = roomsClock.value.at
      ? { at: roomsClock.value.at, recvAt: roomsClock.value.recvAt }
      : { at: now.value, recvAt: now.value };
  }

  function rememberKey(next: string | null): void {
    if (next) {
      saveAdminKey(next);
      rememberedKey.value = next;
      return;
    }
    saveAdminKey(null);
    rememberedKey.value = '';
  }

  /* ---------------- ack 封装（语义同 useSocket.emitAck） ---------------- */

  function emitAck<E extends keyof AdminClientToServerEvents>(
    event: E,
    payload: PayloadOf<E>,
    cb: (res: AdminAckOutcome<AckResultOf<E>>) => void,
  ): void {
    const current = socket;
    if (!current || !current.connected) {
      cb({ ok: false, error: 'OFFLINE', message: '还没连上服务器，稍等一下再试' });
      return;
    }
    let settled = false;
    let timer = 0;
    const settle = (res: AdminAckOutcome<AckResultOf<E>>): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      cb(res);
    };
    timer = window.setTimeout(() => {
      settle({ ok: false, error: 'TIMEOUT', message: '服务器没回应，稍后再试' });
    }, ACK_TIMEOUT_MS);

    try {
      // socket.emit 的泛型重载无法从「运行时 event 变量」推导，这里收敛成最小签名后调用；
      // 对外的类型安全由 emitAck 的泛型签名保证。
      const rawEmit = (current as unknown as {
        emit: (ev: string, data: unknown, ack: (res: unknown) => void) => void;
      }).emit.bind(current);
      rawEmit(event, payload, (res: unknown) => {
        if (res && typeof res === 'object' && typeof (res as { ok?: unknown }).ok === 'boolean') {
          settle(res as AdminAckOutcome<AckResultOf<E>>);
        } else {
          settle({ ok: false, error: 'BAD_ACK', message: '服务器返回异常' });
        }
      });
    } catch {
      settle({ ok: false, error: 'EMIT_FAILED', message: '发送失败，再试一次' });
    }
  }

  /* ---------------- socket 事件 ---------------- */

  function onConnect(): void {
    status.value = 'authed';
    gateError.value = '';
    view.value = 'panel';
    rememberKey(currentKey);
    // 断线期间可能在途的请求已失效，先把 loading 归位，避免重连后自动补拉被 guard 挡住
    refreshing.value = false;
    watching.value = false;
    // 重连成功后先拉一次当前列表，并把断线前的观战恢复回来
    refreshRooms();
    if (selectedCode.value) watchRoom(selectedCode.value, true);
  }

  function onDisconnect(): void {
    if (status.value === 'idle') return;
    // 面板保留（socket.io 会按退避自动重连），只把状态文字切成「已断线」
    status.value = 'error';
  }

  function onConnectError(err: Error): void {
    const message = err && typeof err.message === 'string' ? err.message : '';
    if (message === ADMIN_AUTH_ERROR) {
      gateError.value = '密钥不对，再试试（若持续失败请检查服务端 .env 的 ADMIN_KEY）';
      status.value = 'error';
      view.value = 'gate';
      rememberKey(null);
      return;
    }
    if (message === ADMIN_RATE_LIMIT_ERROR) {
      gateError.value = '错误次数过多，请 1 分钟后再试';
      status.value = 'error';
      view.value = 'gate';
      return;
    }
    if (view.value === 'gate') {
      gateError.value =
        '连不上服务器，检查网络或稍后再试（服务端未配置 ADMIN_KEY 时管理后台会被禁用）';
      status.value = 'error';
      return;
    }
    status.value = 'error';
  }

  function onRoomsEvent(payload: AdminRoomsPayload): void {
    applyRooms(payload);
  }

  function onRoomStateEvent(payload: AdminRoomStatePayload): void {
    if (!payload || payload.code !== selectedCode.value) return;
    detail.value = payload.detail;
    closedReason.value = '';
    detailClock.value = {
      at: Number(payload.at) || 0,
      recvAt: Date.now(),
    };
  }

  function onRoomClosedEvent(payload: AdminRoomClosedPayload): void {
    if (!payload || payload.code !== selectedCode.value) return;
    closedReason.value = payload.reason === 'deleted' ? 'deleted' : 'expired';
  }

  /* ---------------- 用户动作 ---------------- */

  function openSocket(): void {
    if (!socket) {
      socket = io(ADMIN_NAMESPACE, {
        auth: { key: currentKey } satisfies AdminHandshakeAuth,
        reconnection: true,
        reconnectionDelay: 700,
        reconnectionDelayMax: 4000,
        timeout: 8000,
      }) as AdminSocket;
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
      socket.on('connect_error', onConnectError);
      socket.on('admin:rooms', onRoomsEvent);
      socket.on('admin:room:state', onRoomStateEvent);
      socket.on('admin:room:closed', onRoomClosedEvent);
      return;
    }
    // 复用已有 socket：带上新密钥重新握手（鉴权失败后 socket 不会自动重试）
    socket.auth = { key: currentKey };
    socket.connect();
  }

  function login(rawKey: string): void {
    const next = String(rawKey || '').trim();
    if (!next) {
      gateError.value = '先输入管理密钥';
      return;
    }
    if (status.value === 'connecting' || status.value === 'authed') return;
    currentKey = next;
    gateError.value = '';
    status.value = 'connecting';
    openSocket();
  }

  /** 退出登录：清 sessionStorage、断开 socket、清空所有观战与列表状态 */
  function logout(): void {
    rememberKey(null);
    currentKey = '';
    status.value = 'idle';
    view.value = 'gate';
    gateError.value = '';
    if (socket) socket.disconnect();
    rooms.value = [];
    totalRooms.value = 0;
    totalPlayers.value = 0;
    roomsClock.value = EMPTY_CLOCK;
    selectedCode.value = '';
    detail.value = null;
    detailClock.value = EMPTY_CLOCK;
    closedReason.value = '';
    deletePending.value = '';
    deleteConfirmCode.value = '';
    deleteConfirmUntil.value = 0;
  }

  /** 主动拉一次房间列表；失败时给出提示（silent 用于自动补拉，不打扰用户） */
  function refreshRooms(silent = false): void {
    if (refreshing.value) return;
    const current = socket;
    if (!current || !current.connected) {
      if (!silent) toastApi.toast('还没连上服务器，稍等一下再刷新');
      return;
    }
    refreshing.value = true;
    emitAck('admin:rooms:request', {}, (res) => {
      refreshing.value = false; // §12：成功失败都归位
      if (!res.ok) {
        if (!silent) toastApi.toast(res.message || '刷新房间列表失败，稍后再试');
        return;
      }
      applyRooms(res.rooms);
    });
  }

  /** 进入观战：立即拿一份快照，之后靠 admin:room:state 实时更新 */
  function watchRoom(code: string, silent = false): void {
    const target = String(code || '').trim();
    if (!target || watching.value) return;
    watching.value = true;
    emitAck('admin:room:watch', { code: target }, (res) => {
      watching.value = false; // §12：成功失败都归位
      if (!res.ok) {
        if (selectedCode.value === target) {
          // 断线期间房间可能已经结束：保留详情壳并显示「已关闭」提示
          closedReason.value = closedReason.value || 'expired';
        }
        if (!silent) toastApi.toast(res.message || '进入观战失败，房间可能刚被关闭');
        refreshRooms(true);
        return;
      }
      applyDetail(target, res.detail);
    });
  }

  /** 返回房间列表：停止观战（失败也不影响本地关面板） */
  function closeDetail(): void {
    const code = selectedCode.value;
    selectedCode.value = '';
    detail.value = null;
    detailClock.value = EMPTY_CLOCK;
    closedReason.value = '';
    if (code) {
      emitAck('admin:room:unwatch', { code }, () => {
        /* 停止观战不关心 ack 结果 */
      });
    }
  }

  /**
   * 终止房间（UI 层必须二次确认后调用）：
   * 成功后 toast「房间已终止」，被观看的房间由服务端推送 admin:room:closed 兜底。
   */
  function requestDelete(code: string): void {
    const target = String(code || '').trim();
    if (!target || deletePending.value) return;
    const confirming =
      deleteConfirmCode.value === target && now.value < deleteConfirmUntil.value;
    if (!confirming) {
      // 首次点击：进入 4s 二次确认窗（按钮文案变「确认终止？」）
      deleteConfirmCode.value = target;
      deleteConfirmUntil.value = Date.now() + DELETE_CONFIRM_MS;
      toastApi.toast('再点一次「确认终止？」终止房间');
      return;
    }
    deleteConfirmCode.value = '';
    deleteConfirmUntil.value = 0;
    deletePending.value = target;
    emitAck('admin:room:delete', { code: target }, (res) => {
      deletePending.value = ''; // §12：成功失败都归位
      if (!res.ok) {
        toastApi.toast(res.message || '终止房间失败，稍后再试');
        refreshRooms(true);
        return;
      }
      toastApi.toast('房间已终止');
      if (selectedCode.value === target) closedReason.value = 'deleted';
      refreshRooms(true);
    });
  }

  /** 该房间是否正在终止（按钮 loading / disabled） */
  function isDeletePending(code: string): boolean {
    return deletePending.value === code;
  }

  /** 该房间是否处于 4s 二次确认窗（按钮文案「确认终止？」） */
  function isDeleteConfirming(code: string): boolean {
    return deleteConfirmCode.value === code && now.value < deleteConfirmUntil.value;
  }

  /** 100ms 主循环：推进倒计时，并让过期的二次确认自动复位 */
  function tickTimers(): void {
    now.value = Date.now();
    if (deleteConfirmCode.value && now.value >= deleteConfirmUntil.value) {
      deleteConfirmCode.value = '';
      deleteConfirmUntil.value = 0;
    }
  }

  /** 启动时若有记住的密钥则自动登录（刷新免重输，PROTOCOL §14.1） */
  function init(): void {
    if (initialized) return;
    initialized = true;
    if (rememberedKey.value) login(rememberedKey.value);
  }

  return reactive({
    // 状态
    view,
    status,
    statusText,
    gateError,
    gateBusy,
    rememberedKey,
    // 房间列表
    rooms,
    hasRooms,
    totalRooms,
    totalPlayers,
    refreshing,
    // 观战详情
    selectedCode,
    detail,
    watching,
    closedReason,
    closedText,
    detailCountdown,
    // 终止房间
    deletePending,
    // 动作
    init,
    login,
    logout,
    refreshRooms,
    watchRoom,
    closeDetail,
    requestDelete,
    isDeletePending,
    isDeleteConfirming,
    tickTimers,
    // 展示工具
    phaseText,
    countdownText,
    waitingText,
    submitLimitText,
  });
}

/** 应用级单例：整个管理页共用一份连接与状态 */
export type AdminSession = ReturnType<typeof createAdminSession>;

let singleton: AdminSession | null = null;

export function useAdminSocket(): AdminSession {
  if (!singleton) singleton = createAdminSession();
  return singleton;
}
