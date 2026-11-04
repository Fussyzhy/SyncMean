/**
 * 对局会话（旧 public/app.js 的 app.state + 本地态 + 渲染派发，组合式函数版）。
 *
 * 职责：
 * - 唯一的网络状态来源：room:state 与各事件在这里落到 state / 本地兜底态；
 * - 视图派发：state.phase → home / room / game / settle（与旧 showView 一致）；
 * - 派生展示数据（computed）：对局页、房间页、结算页要显示的一切；
 * - 用户动作：建房 / 加入 / 准备 / 提交 / 同意词 / 下一轮 / 重开 / 离开 / 导出。
 *
 * 单例：整个应用只有一个会话（同一页面只有一个 socket / 一份房间状态）。
 */

import { computed, reactive, ref, watch } from 'vue';
import { DEFAULT_SUBMIT_MS, INTERACT_KINDS, SUBMIT_LIMIT_OPTIONS } from '@shared/protocol';
import type {
  AgreePair,
  InteractKind,
  PublicPlayer,
  PublicRoomState,
  Result,
  RevealPayload,
  Seat,
  SubmitLimitMs,
  WinBy,
  CountdownPayload,
  RoundOpenPayload,
  NoticePayload,
  InteractedPayload,
  RoomErrorPayload,
} from '@shared/protocol';
import { useSocket } from './useSocket';
import { useToast } from './useToast';
import { useSound } from './useSound';
import { useCountdown } from './useCountdown';
import { useConfetti } from './useConfetti';
import { useInteractionFx } from '@/composables/useInteractionFx';
import {
  KEY_NICK,
  loadNick,
  loadSession,
  loadToken,
  makeToken,
  saveNick,
  saveSession,
  saveToken,
  type StoredSession,
} from '@/lib/storage';
import { copyText } from '@/lib/clipboard';
import {
  basisPhrase,
  buildSettleModel,
  findMe,
  findPlayer,
  formatClock,
  normalizeCode,
  opponentWatchingSettle,
  resolveWinBy,
  truncate12,
  uniqueHistoryDesc,
  type SettleModel,
} from '@/lib/format';
import { copyPoster, exportCapability, exportPoster } from '@/lib/exportImage';

/** 填词时限的中文文案（0 = 不限时）；白名单外的值按分钟/秒兜底，避免显示原始毫秒 */
const SUBMIT_LIMIT_LABELS: Record<number, string> = {
  0: '不限时',
  60000: '1 分钟',
  180000: '3 分钟',
  300000: '5 分钟',
};

function submitLimitLabel(ms: number): string {
  const known = SUBMIT_LIMIT_LABELS[ms];
  if (known) return known;
  if (ms <= 0) return '不限时';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? seconds + ' 秒' : Math.round(seconds / 60) + ' 分钟';
}

/**
 * v3.6 玩家互动的白名单文案（只允许预设值，服务端会再校验一次）。
 * 接收提示的 `{name}` 是发起方昵称，发送提示的 `{name}` 是对方昵称。
 */
const INTERACT_LABELS: Record<
  InteractKind,
  {
    label: string;
    emoji: string;
    received(name: string): string;
    sent(name: string): string;
  }
> = {
  poke: {
    label: '戳一戳',
    emoji: '👉',
    received: (name) => name + ' 戳了戳你',
    sent: (name) => '已戳「' + name + '」一下',
  },
  tomato: {
    label: '扔番茄',
    emoji: '🍅',
    received: (name) => name + ' 朝你扔了个番茄 🍅',
    sent: (name) => '番茄已扔向「' + name + '」',
  },
  coffee: {
    label: '倒咖啡',
    emoji: '☕',
    received: (name) => name + ' 给你倒了杯咖啡 ☕',
    sent: (name) => '给「' + name + '」倒了杯咖啡',
  },
};

/** 互动被服务端拒绝（对方离线 / 冷却中）时的统一提示 */
const INTERACT_REJECTED_TEXT = '对方不在线，或手速太快啦～';

/** v3.6 互动本地冷却（与 INTERACT_COOLDOWN_MS 对齐）：点击后立即置灰，不等 ack */
const INTERACT_COOLDOWN_MS = 1000;

/** v2.1 §5.3.1：对方还留在结算页时，准备页的统一提示（tip 与按钮 tooltip 共用同一句） */
const SETTLE_WATCH_TIP = '对方还在看上一局的结算，等你俩都点『再来一局』才能开始～';

export type ViewName = 'home' | 'room' | 'game' | 'settle';

interface AgreeView {
  you: boolean;
  opponent: boolean;
}

interface AgreeAck {
  round: number;
  you: boolean;
  opponent: boolean;
}

interface RevealCardView {
  who: string;
  word: string;
  note: string;
  you: boolean;
}

interface BasisView {
  has: boolean;
  text: string;
  sub: string;
  a: string;
  b: string;
}

interface SubmitLimitOption {
  ms: SubmitLimitMs;
  label: string;
  active: boolean;
}

interface InteractOption {
  kind: InteractKind;
  label: string;
  emoji: string;
  disabled: boolean;
}

function otherSeat(seat: Seat): Seat {
  return seat === 'a' ? 'b' : 'a';
}

function createGameSession() {
  const socketApi = useSocket();
  const toastApi = useToast();
  const sound = useSound();
  const countdown = useCountdown();
  const confetti = useConfetti();
  const interactionFx = useInteractionFx();

  /* ---------------- 基础状态 ---------------- */

  const view = ref<ViewName>('home');
  const state = ref<PublicRoomState | null>(null);
  const token = ref('');
  const session = ref<StoredSession | null>(null);
  const nickname = ref('');
  const codeInput = ref('');
  const wordInput = ref('');
  const netText = ref('');
  const pendingCreate = ref(false);
  const pendingJoin = ref(false);
  const readyBusy = ref(false);
  const submitBusy = ref(false);
  const nextBusy = ref(false);
  const restartBusy = ref(false);
  const agreeBusy = ref(false);
  const exportBusy = ref(false);
  const localSubmitted = ref(false);
  const opponentSubmitted = ref(false);
  /** 本轮自己提交成功的时刻（ms）；0 = 本轮还没提交 / 已换轮，用于「已等 m:ss」等待计时 */
  const submittedAt = ref(0);
  /** 创建房间时房主选定的填词时限（仅建房生效；进房后以 state.submitLimitMs 为准） */
  const submitLimitMs = ref<SubmitLimitMs>(DEFAULT_SUBMIT_MS);
  /** v3.7：建房时是否开启语音连麦（房间级参数，默认开；进房后以 state.voice.enabled 为准） */
  const voiceEnabled = ref(true);
  const agreeAck = ref<AgreeAck | null>(null);
  const settleAt = ref(0);
  const openRound = ref(0);
  const openDeadline = ref(0);
  const exportPreviewUrl = ref('');
  const lastReveal = ref<RevealPayload | null>(null);
  const revealTick = ref(0);
  const now = ref(Date.now());
  const joinFocusTick = ref(0);
  /** v3.6 玩家互动冷却截止时刻（ms）：1s 内三个互动按钮全部置灰 */
  const interactCooldownUntil = ref(0);
  /** 「结束本局」二次确认截止时刻（ms）：now < 它时按钮处于确认态 */
  const endConfirmUntil = ref(0);
  /** 点过「再来一局」后，等对方也退出结算页再自动准备 */
  const autoReadyPending = ref(false);

  const copySupported = exportCapability().copy;

  let ignoreState = false;
  let leaving = false;
  let lastRound = 0;
  let revealRound = 0;
  let winRound = 0;

  /* ---------------- 派生：通用 ---------------- */

  const phase = computed(() => (state.value ? state.value.phase : ''));
  const players = computed<PublicPlayer[]>(() => {
    const st = state.value;
    return st && Array.isArray(st.players) ? st.players : [];
  });
  const me = computed<PublicPlayer | null>(() => findMe(state.value));
  const opponent = computed<PublicPlayer | null>(
    () => players.value.find((p) => p && !p.isYou) || null,
  );
  /** 对方是否在线（state.players[].connected 为准；没进房时恒 false） */
  const opponentConnected = computed(() => {
    const op = opponent.value;
    return !!op && op.connected === true;
  });
  /** 对方已进房但掉线（仅用于对局中提示，不等同于「还没进来」） */
  const opponentOffline = computed(() => {
    const op = opponent.value;
    return !!op && !op.connected;
  });

  function resolutionFor(st: PublicRoomState | null): Result | null {
    if (!st) return null;
    if (st.result && st.result.words) return st.result;
    const ev = lastReveal.value;
    if (ev && ev.words && ev.round === st.round) {
      return {
        round: ev.round,
        words: ev.words,
        isWin: !!ev.isWin,
        timedOut: ev.timedOut,
        agree: ev.agree,
        winBy: ev.winBy,
      };
    }
    return null;
  }

  const result = computed<Result | null>(() => resolutionFor(state.value));
  const winBy = computed<WinBy | null>(() => resolveWinBy(state.value, result.value));
  const showReveal = computed(() => {
    const st = state.value;
    if (!st) return false;
    if (st.phase === 'countdown' || st.phase === 'lobby' || st.phase === 'aborted') return false;
    return !!result.value;
  });

  const verdictText = computed(() => {
    const res = result.value;
    if (!showReveal.value || !res) return '';
    if (!res.isWin) return '不一样，继续联想';
    return winBy.value === 'agree' ? '双方确认同意词，通关！🎉' : '一模一样，通关！🎉';
  });

  function buildRevealCard(seat: Seat): RevealCardView {
    const st = state.value;
    const fallback = seat === 'a' ? '玩家 A' : '玩家 B';
    const player = findPlayer(st, seat);
    const name = player ? player.name || fallback : fallback;
    const res = result.value;
    if (!res) return { who: name, word: '—', note: '', you: false };
    const words = res.words || { a: '', b: '' };
    const timedOut = res.timedOut || { a: false, b: false };
    return {
      who: name + (player && player.isYou ? ' · 你' : ''),
      word: words[seat] || '词穷',
      note: timedOut[seat] ? '超时，自动填词' : '',
      you: !!(player && player.isYou),
    };
  }

  const revealA = computed(() => buildRevealCard('a'));
  const revealB = computed(() => buildRevealCard('b'));

  /* ---------------- 派生：房间页 ---------------- */

  const roomCodeText = computed(
    () => (state.value && state.value.code) || (session.value && session.value.code) || '----',
  );
  const roomPhaseText = computed(() =>
    state.value ? players.value.length + ' / 2 人' : '1 / 2 人',
  );
  /** 房间实际生效的填词时限：state 到手后以服务端为准，未到时先用本地建房选择兜底 */
  const roomSubmitLimitMs = computed<number>(() => {
    const st = state.value;
    if (st && typeof st.submitLimitMs === 'number') return st.submitLimitMs;
    return submitLimitMs.value;
  });
  /** 首页「填词时限」选项（含选中态），供 HomeView 渲染 */
  const submitLimitOptions = computed<SubmitLimitOption[]>(() =>
    SUBMIT_LIMIT_OPTIONS.map((ms) => ({
      ms,
      label: submitLimitLabel(ms),
      active: submitLimitMs.value === ms,
    })),
  );
  const submitLimitText = computed(() => submitLimitLabel(roomSubmitLimitMs.value));
  /** 本局不限时：没有截止时间，双方都提交才揭晓 */
  const timerUnlimited = computed(() => roomSubmitLimitMs.value <= 0);
  const readyPressed = computed(() => !!(me.value && me.value.ready));
  const watchingSettle = computed(() => opponentWatchingSettle(state.value, opponent.value));
  const readyDisabled = computed(() => {
    const st = state.value;
    if (!st || st.phase !== 'lobby' || readyBusy.value || watchingSettle.value) return true;
    return false;
  });

  const seatA = computed<PublicPlayer | null>(() => {
    const st = state.value;
    if (st) return findPlayer(st, 'a');
    const sess = session.value;
    if (!sess) return null;
    return {
      seat: 'a',
      name: sess.name,
      isHost: true,
      ready: false,
      connected: true,
      isYou: true,
      settleDismissed: false,
    };
  });
  const seatB = computed<PublicPlayer | null>(() => {
    const st = state.value;
    if (st) return findPlayer(st, 'b');
    return null;
  });

  const roomTip = computed(() => {
    const op = opponent.value;
    if (watchingSettle.value) return SETTLE_WATCH_TIP;
    if (!op) return '房间建好了，把码发给朋友，等 TA 进来～';
    if (!op.connected) return '对方掉线了，房间还留着，等他回来就能继续。';
    if (readyPressed.value && op.ready) return '双方都准备好，马上开始！';
    if (readyPressed.value) return '你已经准备好啦，等对方点准备…';
    if (op.ready) return '对方已经准备好了，就差你啦！';
    return '两个人都点准备，就开始第 1 轮。';
  });

  /* ---------------- 派生：对局页 ---------------- */

  const opened = computed(() => {
    const st = state.value;
    if (!st) return false;
    return (
      st.phase === 'submitting' ||
      (st.phase === 'countdown' && openRound.value === Number(st.round))
    );
  });

  const submittedYou = computed(() => {
    const st = state.value;
    return !!(st && st.submitted && st.submitted.you) || localSubmitted.value;
  });
  const opponentDone = computed(
    () => !!(state.value && state.value.submitted && state.value.submitted.opponent) ||
      opponentSubmitted.value,
  );
  const canType = computed(() => opened.value && !submittedYou.value && !showReveal.value);
  const playHidden = computed(() => showReveal.value);
  const submitLabel = computed(() => (submittedYou.value && opened.value ? '已提交' : '提交'));
  const wordPlaceholder = computed(() => {
    if (submittedYou.value && opened.value) return '已经提交，等对方…';
    if (opened.value) return '写一个词，最多 12 个字';
    return '倒计时结束就能写啦';
  });
  const waitingOn = computed(() => opened.value && !showReveal.value && submittedYou.value);
  /** 等待仪表盘文案：已提交，等对方 · 已等 m:ss（· 对方离线）；未提交/已揭晓时为空串 */
  const waitingText = computed(() => {
    if (!waitingOn.value) return '';
    let text = '已提交，等对方';
    if (submittedAt.value) {
      text += ' · 已等 ' + formatClock(now.value - submittedAt.value);
    }
    if (opponentOffline.value) text += ' · 对方离线';
    return text;
  });
  const opponentHintOn = computed(
    () => opened.value && !showReveal.value && !submittedYou.value && opponentDone.value,
  );

  /** v3.6 玩家互动选项（等待对方时可用；1s 冷却中全部置灰） */
  const interactOptions = computed<InteractOption[]>(() =>
    INTERACT_KINDS.map((kind) => ({
      kind,
      label: INTERACT_LABELS[kind].label,
      emoji: INTERACT_LABELS[kind].emoji,
      disabled: now.value < interactCooldownUntil.value,
    })),
  );
  /** 只在「输入已开放、还没揭晓、对方在线」时展示互动条 */
  const interactVisible = computed(
    () => opened.value && !showReveal.value && opponentConnected.value,
  );

  /** v3.4「结束本局」：对局中任意相位可点（won / lobby 不可） */
  const endAvailable = computed(
    () => phase.value === 'countdown' || phase.value === 'submitting' || phase.value === 'reveal',
  );
  const endConfirmPending = computed(() => now.value < endConfirmUntil.value);

  const submitRemain = computed(() => {
    const total = roomSubmitLimitMs.value;
    // 不限时：没有截止时刻，进度条/倒计时都按 0 处理
    if (total <= 0) return 0;
    const st = state.value;
    if (!st) return total;
    const fallbackOpen = st.phase === 'countdown' && openRound.value === Number(st.round);
    if (st.phase !== 'submitting' && !fallbackOpen) return total;
    const deadline = st.phase === 'submitting' ? st.deadline : openDeadline.value;
    // round:open 的 deadline 可能为 null（不限时），也可能还没到：都回落到整段时限
    if (typeof deadline !== 'number' || !deadline) return total;
    let remain = deadline - now.value;
    if (remain > total) remain = total;
    if (remain < 0) remain = 0;
    return remain;
  });
  const timerVisible = computed(() => opened.value && !showReveal.value);
  const timerWidth = computed(() => {
    const total = roomSubmitLimitMs.value;
    if (total <= 0) return '0%';
    return ((submitRemain.value / total) * 100).toFixed(1) + '%';
  });
  const timerLow = computed(() => !timerUnlimited.value && submitRemain.value <= 10000);
  const timerText = computed(() => {
    if (timerUnlimited.value) return '不限时';
    const remain = submitRemain.value;
    if (remain <= 0) return '时间到，等揭晓…';
    const seconds = Math.ceil(remain / 1000);
    if (seconds < 60) return seconds + ' 秒';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  });

  const roundLabel = computed(() => '第 ' + (Number(state.value && state.value.round) || 1) + ' 轮');
  const gameCode = computed(() => (state.value && state.value.code) || '----');

  const basisView = computed<BasisView>(() => {
    const basis = state.value ? state.value.basis : null;
    if (!basis || !basis.a || !basis.b) {
      return {
        has: false,
        text: '第一轮：随便想一个词',
        sub: '别想太多，想到什么写什么，看看你们能不能撞上。',
        a: '',
        b: '',
      };
    }
    return {
      has: true,
      text: '从这两个词出发，想到一起',
      sub: '上一轮的两个词就是线索，把思路往中间靠一靠。',
      a: basis.a,
      b: basis.b,
    };
  });

  /* ---------------- 派生：同意词投票 ---------------- */

  const agreeView = computed<AgreeView>(() => {
    const st = state.value;
    const raw = st && st.agree;
    if (raw && typeof raw === 'object') {
      return { you: !!raw.you, opponent: !!raw.opponent };
    }
    const ack = agreeAck.value;
    if (ack && st && Number(ack.round) === Number(st.round)) {
      return { you: !!ack.you, opponent: !!ack.opponent };
    }
    return { you: false, opponent: false };
  });
  const agreeRowVisible = computed(() => {
    const st = state.value;
    const res = result.value;
    return !!st && st.phase === 'reveal' && !(res && res.isWin);
  });
  const agreePressed = computed(() => agreeView.value.you);
  const agreeOpponentOn = computed(() => agreeView.value.opponent);
  const agreeOpponentText = computed(() =>
    agreeView.value.opponent ? '对方已确认 ✓' : '对方还没确认',
  );
  const agreeHintText = computed(() => {
    const v = agreeView.value;
    if (v.you && v.opponent) return '双方都确认了，正在通关…';
    if (v.you) return '你已确认，等对方也点一下，两个都确认就通关。';
    if (v.opponent) return '对方已确认这两个词是同意词，你这边点一下就通关。';
    return '觉得这两个词说的是一回事？你确认后，等对方也确认就通关。';
  });

  const nextVisible = computed(() => showReveal.value && phase.value !== 'won');
  /** 揭晓阶段永不自动推进：只提示玩家点按钮 */
  const nextHintText = computed(() => {
    const st = state.value;
    if (!st || !showReveal.value || st.phase === 'won') return '';
    return '揭晓后不会自动推进，看完点下面按钮进入下一轮';
  });

  /* ---------------- 派生：loading / 历史 / 结算 ---------------- */

  const readyBusyShown = computed(() => readyBusy.value && phase.value === 'lobby');
  const submitBusyShown = computed(
    () => submitBusy.value && (phase.value === 'countdown' || phase.value === 'submitting'),
  );
  const agreeBusyShown = computed(() => agreeBusy.value && phase.value === 'reveal');
  const nextBusyShown = computed(() => nextBusy.value && phase.value === 'reveal');
  const restartBusyShown = computed(() => restartBusy.value && phase.value === 'won');
  const exportBusyShown = computed(() => exportBusy.value && phase.value === 'won');

  const historyItems = computed(() => uniqueHistoryDesc(state.value ? state.value.history : []));

  const settleModel = computed<SettleModel | null>(() => {
    const st = state.value;
    if (!st) return null;
    return buildSettleModel(st, settleAt.value || Date.now());
  });
  const settleMeta = computed(() => {
    const m = settleModel.value;
    if (!m) return '';
    return '房间码 ' + m.code + ' · ' + m.nameA + ' 与 ' + m.nameB + ' · ' + m.dateText;
  });
  const settleStats = computed(() => {
    const m = settleModel.value;
    if (!m) return '';
    return (
      '本局共 ' +
      m.totalRounds +
      ' 轮 · 同意词确认通关 ' +
      m.agreeRounds +
      ' 轮 · 一模一样通关 ' +
      m.sameRounds +
      ' 轮'
    );
  });

  /* ---------------- 内部工具 ---------------- */

  function mySeat(st: PublicRoomState | null): Seat {
    const myself = findMe(st);
    const seat =
      (st && st.you && st.you.seat) ||
      (session.value ? session.value.seat : '') ||
      (myself ? myself.seat : '');
    return seat === 'b' ? 'b' : 'a';
  }

  function resetAllLoading(): void {
    readyBusy.value = false;
    submitBusy.value = false;
    nextBusy.value = false;
    restartBusy.value = false;
    agreeBusy.value = false;
    exportBusy.value = false;
    pendingCreate.value = false;
    pendingJoin.value = false;
  }

  function clearStoredSession(): void {
    session.value = null;
    saveSession(null);
  }

  function syncSession(st: PublicRoomState): void {
    let current = session.value;
    if (!current) {
      current = {
        code: st.code,
        token: token.value,
        name: (st.you && st.you.name) || '',
        seat: (st.you && st.you.seat) || '',
      };
      session.value = current;
    }
    current.code = st.code || current.code;
    if (st.you && st.you.seat) current.seat = st.you.seat;
    if (st.you && st.you.name) current.name = st.you.name;
    if (!current.token) current.token = token.value;
    saveSession(current);
  }

  /* ---------------- 渲染派发（旧 render 的等价物） ---------------- */

  function applyRevealEffects(st: PublicRoomState): void {
    const res = resolutionFor(st);
    const show = !!res && st.phase !== 'countdown' && st.phase !== 'lobby';
    if (!show) {
      revealRound = 0;
      winRound = 0;
      return;
    }
    const round = Number(res.round) || Number(st.round) || 1;
    if (revealRound !== round) {
      revealRound = round;
      revealTick.value += 1;
      // v3.4：未通关「结束本局」也会进入 won 视角，进结算页时不该再播揭晓音
      if (!res.isWin && st.phase !== 'won') sound.reveal();
    }
    // v3.4：只有真正通关（isWin）才撒花/播胜利音；「结束本局」的非通关快照不庆祝
    if (st.phase === 'won' && res.isWin && winRound !== round) {
      winRound = round;
      confetti.celebrate();
      sound.win();
    }
  }

  function onAborted(): void {
    toastApi.toast('这局结束啦，回首页重新开一局吧');
    teardown('');
  }

  function applyState(next: PublicRoomState | null | undefined): void {
    if (!next || typeof next !== 'object' || !next.code) return;
    if (ignoreState) return;

    const round = Number(next.round) || 1;
    if (round !== lastRound) {
      lastRound = round;
      localSubmitted.value = false;
      opponentSubmitted.value = false;
      submittedAt.value = 0;
      endConfirmUntil.value = 0;
      lastReveal.value = null;
      revealRound = 0;
      winRound = 0;
      openRound.value = 0;
      openDeadline.value = 0;
      agreeAck.value = null;
      wordInput.value = '';
    }
    state.value = next;
    syncSession(next);

    if (next.phase === 'aborted') {
      onAborted();
      return;
    }

    if (next.phase === 'lobby') {
      localSubmitted.value = false;
      opponentSubmitted.value = false;
      submittedAt.value = 0;
      endConfirmUntil.value = 0;
      lastReveal.value = null;
      revealRound = 0;
      winRound = 0;
      openRound.value = 0;
      openDeadline.value = 0;
      agreeAck.value = null;
      countdown.resetCountdown();
      wordInput.value = '';
      settleAt.value = 0;
      exportPreviewUrl.value = '';
      confetti.clear();
      view.value = 'room';
      return;
    }

    if (next.phase === 'won') {
      // 先同步对局页内容（揭晓卡、判定文案、撒花、通关音效），再切到结算视图
      applyRevealEffects(next);
      if (!settleAt.value) settleAt.value = Date.now();
      view.value = 'settle';
      return;
    }

    view.value = 'game';
    applyRevealEffects(next);
    if (next.phase === 'countdown') countdown.ensureCountdown(next);
  }

  function teardown(message: string): void {
    clearStoredSession();
    ignoreState = true;
    state.value = null;
    localSubmitted.value = false;
    opponentSubmitted.value = false;
    submittedAt.value = 0;
    endConfirmUntil.value = 0;
    autoReadyPending.value = false;
    lastRound = 0;
    lastReveal.value = null;
    revealRound = 0;
    winRound = 0;
    openRound.value = 0;
    openDeadline.value = 0;
    agreeAck.value = null;
    settleAt.value = 0;
    exportPreviewUrl.value = '';
    resetAllLoading();
    leaving = false;
    countdown.resetCountdown();
    wordInput.value = '';
    confetti.clear();
    view.value = 'home';
    if (message) toastApi.toast(message);
  }

  /* ---------------- 用户动作：建房 / 加入 / 恢复 ---------------- */

  function readNickname(): string {
    let name = String(nickname.value || '').trim();
    name = truncate12(name);
    if (name !== nickname.value) nickname.value = name;
    if (!name) {
      toastApi.toast('先给自己起个昵称吧～');
      return '';
    }
    saveNick(name);
    return name;
  }

  /** 只接受白名单里的时限（0 / 1 / 3 / 5 分钟），非法值直接忽略 */
  function setSubmitLimit(ms: number): void {
    const next = SUBMIT_LIMIT_OPTIONS.find((item) => item === ms);
    if (next === undefined) return;
    submitLimitMs.value = next;
  }

  function createRoom(name: string): void {
    if (pendingCreate.value) return;
    ignoreState = false;
    pendingCreate.value = true;
    socketApi.emitAck(
      'room:create',
      {
        name,
        token: token.value,
        submitLimitMs: submitLimitMs.value,
        voiceEnabled: voiceEnabled.value,
      },
      (res) => {
        pendingCreate.value = false;
        if (!res.ok) {
          toastApi.toast(res.message || '建房失败了，再试一次');
          return;
        }
        leaving = false;
        session.value = {
          code: res.code,
          token: res.token || token.value,
          name,
          seat: res.seat || 'a',
        };
        saveSession(session.value);
        // 服务器可能先广播 room:state 再回 ack，此时房间已经渲染好了
        if (!state.value || state.value.code !== res.code) {
          state.value = null;
          view.value = 'room';
        }
        toastApi.toast('房间建好了，把码发给朋友～');
      },
    );
  }

  function joinRoom(code: string, name: string): void {
    ignoreState = false;
    requestJoin({ code, name, token: token.value, restore: false });
  }

  function requestJoin(opts: {
    code: string;
    name: string;
    token: string;
    restore: boolean;
  }): void {
    if (pendingJoin.value) return;
    pendingJoin.value = true;
    socketApi.emitAck(
      'room:join',
      { code: opts.code, name: opts.name, token: opts.token },
      (res) => {
        pendingJoin.value = false;
        if (!res.ok) {
          if (opts.restore) {
            clearStoredSession();
            state.value = null;
            view.value = 'home';
            toastApi.toast(res.message || '之前的房间已经不在了，回首页重新来吧');
            return;
          }
          toastApi.toast(res.message || '加入失败，再试一次');
          return;
        }
        ignoreState = false;
        leaving = false;
        session.value = {
          code: res.code || opts.code,
          token: res.token || opts.token,
          name: opts.name,
          seat: res.seat || 'b',
        };
        saveSession(session.value);
        if (res.state) applyState(res.state);
        toastApi.toast(opts.restore ? '欢迎回来，继续吧' : '加入成功，等人齐就开始');
      },
    );
  }

  function tryRestore(): void {
    const current = session.value;
    if (!current || !current.code) return;
    if (pendingJoin.value) return;
    requestJoin({
      code: current.code,
      name: current.name || loadNick() || '玩家',
      token: current.token || token.value,
      restore: true,
    });
  }

  function leaveNow(message: string): void {
    if (leaving) return;
    leaving = true;
    socketApi.emitAck('room:leave', {}, () => {
      /* 主动离开不关心 ack 结果 */
    });
    teardown(message || '已离开房间');
  }

  /* ---------------- 用户动作：大厅 / 对局 ---------------- */

  function onReady(): void {
    const st = state.value;
    if (!st || st.phase !== 'lobby' || readyBusy.value) return;
    const list = Array.isArray(st.players) ? st.players : [];
    const op = list.find((p) => p && !p.isYou) || null;
    // v2.1 §5.3.1：对方还在结算页时服务端会硬拒 player:ready，这里直接不发起请求
    if (opponentWatchingSettle(st, op)) {
      toastApi.toast(SETTLE_WATCH_TIP);
      return;
    }
    const myself = findMe(st);
    const nextReady = !(myself && myself.ready);
    readyBusy.value = true;
    socketApi.emitAck('player:ready', { ready: nextReady }, (res) => {
      // bug 4：ack 到达时服务端可能已广播新 phase，这里先无条件归位 loading
      readyBusy.value = false;
      if (!res.ok) toastApi.toast(res.message || '准备状态没同步上，再点一次');
    });
  }

  /* ---------------- 用户动作：再来一局自动准备 ---------------- */

  /**
   * v3.4 纯前端自动准备：点过「再来一局」后，等对方也退出结算页（watchingSettle=false），
   * 自己还没准备就自动发 player:ready；协议无变化。
   */
  function maybeAutoReady(): void {
    if (!autoReadyPending.value) return;
    const st = state.value;
    if (!st || st.phase !== 'lobby' || watchingSettle.value) return;
    autoReadyPending.value = false;
    if (me.value && me.value.ready) return;
    onReady();
  }

  // 对方退出结算页（watchingSettle true → false）后触发自动准备
  watch(watchingSettle, () => {
    maybeAutoReady();
  });

  /** 返回 false 表示没有发起提交（空词等），调用方可以把焦点放回输入框 */
  function submitWord(): boolean {
    const st = state.value;
    if (!st) return false;
    const isOpened =
      st.phase === 'submitting' ||
      (st.phase === 'countdown' && openRound.value === Number(st.round));
    if (!isOpened) return false;
    if (submittedYou.value || submitBusy.value) return false;
    const word = truncate12(String(wordInput.value || '').trim());
    if (!word) {
      toastApi.toast('先想一个词再提交呀');
      return false;
    }
    submitBusy.value = true;
    socketApi.emitAck('round:submit', { word }, (res) => {
      submitBusy.value = false; // §12：成功失败都归位
      if (!res.ok) {
        toastApi.toast(res.message || '提交失败了，再试一次');
        return;
      }
      localSubmitted.value = true;
      submittedAt.value = Date.now();
      sound.submit();
    });
    return true;
  }

  /**
   * v3.6 玩家互动：只在等待对方时可用。
   * 冷却反馈不等 ack —— 点下立刻本地置 1s 冷却，避免连点刷请求；
   * 白名单/相位/冷却的最终裁决在服务端，accepted:false 只提示、不自动重试。
   */
  function sendInteract(kind: InteractKind): void {
    if (!interactVisible.value) return;
    if (now.value < interactCooldownUntil.value) return;
    const at = Date.now();
    now.value = at;
    interactCooldownUntil.value = at + INTERACT_COOLDOWN_MS;
    socketApi.emitAck('room:interact', { kind }, (res) => {
      if (!res.ok) {
        toastApi.toast(res.message || '互动没发出去，再试一次');
        return;
      }
      if (!res.accepted) {
        toastApi.toast(INTERACT_REJECTED_TEXT);
        return;
      }
      const op = opponent.value;
      toastApi.toast(INTERACT_LABELS[kind].sent((op && op.name) || '对方'));
    });
  }

  function toggleAgree(): void {
    const st = state.value;
    if (!st || st.phase !== 'reveal' || agreeBusy.value) return;
    const next = !agreeView.value.you;
    agreeBusy.value = true;
    socketApi.emitAck('round:agree', { agree: next }, (res) => {
      agreeBusy.value = false; // §12：成功失败都归位
      if (!res.ok) {
        toastApi.toast(res.message || '同意词没投出去，再点一次试试');
        return;
      }
      // 兜底：并行开发期后端可能还没下发 state.agree，就用 ack 的 agree:{a,b}
      const ackAgree: AgreePair | null = res.agree && typeof res.agree === 'object' ? res.agree : null;
      if (ackAgree) {
        const seat = mySeat(st);
        agreeAck.value = {
          round: Number(st.round) || 0,
          you: !!ackAgree[seat],
          opponent: !!ackAgree[otherSeat(seat)],
        };
      }
    });
  }

  function nextRound(): void {
    if (nextBusy.value) return;
    nextBusy.value = true;
    socketApi.emitAck('round:next', {}, (res) => {
      nextBusy.value = false; // §12：成功失败都归位
      if (!res.ok) toastApi.toast(res.message || '现在还不能跳到下一轮');
    });
  }

  /** v3.4「结束本局」：第一次点进入 4s 确认态，4s 内再点一次才真正结束 */
  function requestEndGame(): void {
    if (!endAvailable.value) return;
    if (endConfirmPending.value) {
      endConfirmUntil.value = 0;
      socketApi.emitAck('game:end', {}, (res) => {
        if (!res.ok) {
          toastApi.toast(res.message || '结束失败');
          return;
        }
        toastApi.toast('本局已结束，可以查看战报或再来一局');
      });
      return;
    }
    endConfirmUntil.value = Date.now() + 4000;
    toastApi.toast('再点一次「结束本局」确认');
  }

  function restartGame(): void {
    if (restartBusy.value) return;
    restartBusy.value = true;
    socketApi.emitAck('game:restart', {}, (res) => {
      restartBusy.value = false; // §12：成功失败都归位
      if (!res.ok) {
        toastApi.toast(res.message || '重开失败了，再试一次');
        return;
      }
      // 回到 lobby 前，把每一颗按钮的 loading 都归位
      resetAllLoading();
      localSubmitted.value = false;
      opponentSubmitted.value = false;
      submittedAt.value = 0;
      endConfirmUntil.value = 0;
      revealRound = 0;
      winRound = 0;
      lastReveal.value = null;
      agreeAck.value = null;
      settleAt.value = 0;
      exportPreviewUrl.value = '';
      confetti.clear();
      // v3.4：回到房间后若对方也已退出结算页，立即自动准备；否则等 watchingSettle 变 false
      autoReadyPending.value = true;
      maybeAutoReady();
      toastApi.toast('已回到房间，双方都回来就自动开始');
    });
  }

  /* ---------------- 用户动作：复制邀请 / 导出 ---------------- */

  function copyInvite(): void {
    const code =
      (state.value && state.value.code) ||
      (session.value && session.value.code) ||
      '';
    if (!code || code === '----') {
      toastApi.toast('房间码还没出来，稍等一下');
      return;
    }
    const link = window.location.origin + '/?room=' + encodeURIComponent(code);
    void copyText(link).then((ok) => {
      toastApi.toast(ok ? '邀请链接复制好啦，发给朋友吧' : '复制没成功，手动把房间码发过去吧');
    });
  }

  async function exportImage(): Promise<void> {
    if (exportBusy.value) return;
    const model = settleModel.value;
    if (!model) {
      toastApi.toast('这局的数据还没齐，稍等一下再导出');
      return;
    }
    exportBusy.value = true;
    try {
      const outcome = await exportPoster(model);
      if (outcome.previewUrl) exportPreviewUrl.value = outcome.previewUrl;
      toastApi.toast(outcome.message, outcome.ok ? 'system' : 'info');
    } finally {
      exportBusy.value = false;
    }
  }

  async function copyExportImage(): Promise<void> {
    if (exportBusy.value) return;
    const model = settleModel.value;
    if (!model) {
      toastApi.toast('这局的数据还没齐，稍等一下再试');
      return;
    }
    if (!copySupported) {
      toastApi.toast('这台设备不支持复制或分享，用「导出图片」下载就行');
      return;
    }
    exportBusy.value = true;
    try {
      const outcome = await copyPoster(model);
      toastApi.toast(outcome.message, outcome.ok ? 'system' : 'info');
    } finally {
      exportBusy.value = false;
    }
  }

  /* ---------------- Socket 事件 ---------------- */

  function setNet(text: string): void {
    netText.value = text;
  }

  function onConnect(): void {
    setNet('');
    // 断线重连：之前在途请求的 ack 永远不会回来了，所有 loading 必须先归位
    resetAllLoading();
    if (state.value && !ignoreState) applyState(state.value);
    if (session.value && !pendingJoin.value) tryRestore();
  }

  function onDisconnect(): void {
    if (session.value || state.value) setNet('连接断开了，正在自动重连…');
  }

  function onConnectError(): void {
    setNet('连不上服务器，正在重试…');
  }

  function onState(next: PublicRoomState): void {
    applyState(next);
  }

  function onCountdownEvent(payload: CountdownPayload): void {
    if (!payload) return;
    const round =
      Number(payload.round) || (state.value ? Number(state.value.round) : 1) || 1;
    const seconds = Number(payload.seconds) > 0 ? Number(payload.seconds) : 3;
    countdown.startCountdown(round, Date.now() + seconds * 1000, basisPhrase(payload.basis));
  }

  function onRoundOpen(payload: RoundOpenPayload): void {
    const activeRound = countdown.currentRound();
    if (activeRound) countdown.endCountdown(activeRound);
    const st = state.value;
    if (!st) return;
    const round = Number(payload && payload.round) || Number(st.round) || 1;
    if (Number(st.round) !== round) return;
    // 服务端已开闸：先解锁输入，内容与判定仍以随后的 room:state 为准
    if (st.phase === 'countdown') {
      openRound.value = round;
      // 不限时房间的 deadline 是 null：只在真是 number 时记录，随后以 room:state 为准
      const deadline = payload ? payload.deadline : null;
      if (typeof deadline === 'number' && deadline > 0) openDeadline.value = deadline;
    }
  }

  function onOpponentSubmitted(): void {
    opponentSubmitted.value = true;
  }

  function onRevealEvent(payload: RevealPayload): void {
    if (!payload || !payload.round) return;
    lastReveal.value = payload;
    opponentSubmitted.value = false;
    const st = state.value;
    if (!st || Number(st.round) !== Number(payload.round)) return;
    if (st.phase === 'submitting' || st.phase === 'countdown') {
      if (st.phase === 'countdown') countdown.endCountdown(Number(payload.round));
      view.value = 'game';
    }
    // state 可能还没到：先用 reveal 事件内容点亮揭晓面板（与旧 render(app.state) 一致）
    applyRevealEffects(st);
  }

  function onNotice(payload: NoticePayload): void {
    if (!payload || !payload.text) return;
    toastApi.toast(payload.text, payload.kind || 'info');
  }

  /**
   * v3.6：被互动方收到 room:interacted —— 全屏特效 + 音效 + 提示。
   * 载荷来自网络，kind 必须先过白名单再用；提示文案一律由前端按白名单生成。
   */
  function onInteracted(payload: InteractedPayload): void {
    const rawKind = payload && (payload.kind as string);
    if (!rawKind || !(INTERACT_KINDS as readonly string[]).includes(rawKind)) return;
    const kind = rawKind as InteractKind;
    const name = String((payload && payload.name) || '').trim() || '对方';
    interactionFx.play(kind);
    sound.interact(kind);
    toastApi.toast(INTERACT_LABELS[kind].received(name));
  }

  function onRoomError(payload: RoomErrorPayload): void {
    const code = payload && payload.code;
    const message = (payload && payload.message) || '房间出了点问题';
    if (ignoreState) return;
    if (code === 'OPPONENT_LEFT') {
      teardown('对方离开了，这局结束');
      return;
    }
    if (code === 'REPLACED') {
      teardown('这个房间在别处打开了，这里先退出');
      return;
    }
    if (code === 'ROOM_DELETED') {
      teardown('房间已经关闭了');
      return;
    }
    toastApi.toast(message);
  }

  function initSocket(): void {
    socketApi.ensureSocket({
      onConnect,
      onDisconnect,
      onConnectError,
      onState,
      onCountdown: onCountdownEvent,
      onRoundOpen,
      onOpponentSubmitted,
      onReveal: onRevealEvent,
      onNotice,
      onInteracted,
      onRoomError,
    });
  }

  /* ---------------- 邀请链接 / 启动 ---------------- */

  function handleInviteLink(): void {
    let params: URLSearchParams | null = null;
    try {
      params = new URLSearchParams(window.location.search);
    } catch {
      params = null;
    }
    if (!params) return;
    const raw = params.get('room');
    if (!raw) return;
    const code = normalizeCode(raw);
    codeInput.value = code;
    // 打开的是别人的邀请链接时，优先展示首页加入，不当成上一次的断线重连
    const current = session.value;
    if (current && current.code && current.code !== code) {
      clearStoredSession();
    }
    window.setTimeout(() => {
      joinFocusTick.value += 1;
    }, 80);
  }

  function init(): void {
    // token 存 sessionStorage：同一浏览器多标签页各自是独立玩家，刷新仍可断线重连
    let storedToken = loadToken();
    if (!storedToken) {
      storedToken = makeToken();
      saveToken(storedToken);
    }
    token.value = storedToken;

    session.value = loadSession();
    if (session.value && !session.value.token) session.value.token = token.value;

    nickname.value = truncate12(loadNick() || '');

    sound.init();
    document.addEventListener(
      'pointerdown',
      () => {
        sound.unlock();
      },
      { once: true },
    );

    handleInviteLink();
    initSocket();
  }

  /** 100ms 主循环里由 App 调用：刷新读秒基准（旧 tickTimers） */
  function tickTimers(): void {
    if (!state.value) return;
    now.value = Date.now();
  }

  return reactive({
    // 状态
    view,
    state,
    session,
    nickname,
    codeInput,
    wordInput,
    netText,
    pendingCreate,
    pendingJoin,
    readyBusy,
    submitBusy,
    nextBusy,
    restartBusy,
    agreeBusy,
    exportBusy,
    localSubmitted,
    opponentSubmitted,
    submittedAt,
    settleAt,
    exportPreviewUrl,
    joinFocusTick,
    copySupported,
    settleWatchTip: SETTLE_WATCH_TIP,
    // 派生：通用
    phase,
    players,
    me,
    opponent,
    opponentConnected,
    opponentOffline,
    result,
    winBy,
    showReveal,
    verdictText,
    revealA,
    revealB,
    revealTick,
    // 派生：房间
    roomCodeText,
    roomPhaseText,
    readyPressed,
    watchingSettle,
    readyDisabled,
    seatA,
    seatB,
    roomTip,
    submitLimitMs,
    submitLimitOptions,
    submitLimitText,
    roomSubmitLimitMs,
    voiceEnabled,
    // 派生：对局
    opened,
    submittedYou,
    opponentDone,
    canType,
    playHidden,
    submitLabel,
    wordPlaceholder,
    waitingOn,
    waitingText,
    opponentHintOn,
    interactOptions,
    interactVisible,
    endAvailable,
    endConfirmPending,
    timerVisible,
    timerWidth,
    timerLow,
    timerText,
    timerUnlimited,
    roundLabel,
    gameCode,
    basisView,
    historyItems,
    // 派生：同意词
    agreeRowVisible,
    agreePressed,
    agreeOpponentOn,
    agreeOpponentText,
    agreeHintText,
    nextVisible,
    nextHintText,
    // 派生：loading / 结算
    readyBusyShown,
    submitBusyShown,
    agreeBusyShown,
    nextBusyShown,
    restartBusyShown,
    exportBusyShown,
    settleModel,
    settleMeta,
    settleStats,
    // 动作
    init,
    readNickname,
    setSubmitLimit,
    createRoom,
    joinRoom,
    leaveRoom: () => leaveNow('已离开房间'),
    onReady,
    submitWord,
    sendInteract,
    toggleAgree,
    nextRound,
    requestEndGame,
    restartGame,
    copyInvite,
    exportImage,
    copyExportImage,
    tickTimers,
  });
}

/** 应用级单例：整个页面共用一份会话状态 */
export type GameSession = ReturnType<typeof createGameSession>;

let singleton: GameSession | null = null;

export function useGameSession(): GameSession {
  if (!singleton) singleton = createGameSession();
  return singleton;
}
