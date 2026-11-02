/**
 * 同声传意 —— 房间与对局状态机（TypeScript / ESM 版，与旧 src/game.js 逐行等价）
 *
 * 本模块不依赖 socket.io / express：所有对外推送都通过构造时注入的回调完成，
 * 方便单测与替换传输层。
 *
 *   new Game({
 *     emitToRoom(code, event, payload),      // 发到房间频道
 *     emitToPlayer(player, event, payload),  // 只发给某个玩家（用 player.socketId）
 *     onSocketReplaced(oldSocketId, room, player), // 旧连接被顶替（可选）
 *   })
 *
 * 协议见 PROTOCOL.md（前后端唯一事实来源）。
 */

import { randomInt, randomUUID } from 'node:crypto';

import { DEFAULT_SUBMIT_MS, SUBMIT_LIMIT_OPTIONS } from '../shared/protocol.js';
import type {
  ActionError,
  ActionResult,
  AgreeOk,
  AgreePair,
  Basis,
  CreateOk,
  CreatePayload,
  ErrorCode,
  HistoryItem,
  JoinOk,
  JoinPayload,
  Phase,
  Result,
  RestartOk,
  Seat,
  ServerToClientEvents,
  SimpleOk,
  SubmitLimitMs,
  SubmitOk,
  WinBy,
} from '../shared/protocol.js';

// ==================== 时间参数（PROTOCOL.md §3，集中于此） ====================
const COUNTDOWN_MS = 3000; // 3-2-1
const START_DELAY = 300; // 双方准备后稍等再倒计时

// 全员离线后的房间保留时长与清理扫描周期（PROTOCOL.md §8）
const OFFLINE_ROOM_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

// ==================== 业务常量 ====================
const CODE_LENGTH = 4;
// 4 位房间码字符集：A-Z + 2-9，排除容易混淆的 0/O/1/I
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{4}$/;
const NAME_MAX = 12;
const WORD_MAX = 12;
const TIMEOUT_WORD = '词穷';

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_NAME: '昵称需为 1–12 个字符',
  INVALID_CODE: '房间码应为 4 位（字母 A–Z 或数字 2–9）',
  ROOM_NOT_FOUND: '房间不存在，请检查房间码',
  ROOM_FULL: '房间已满（最多 2 人）',
  ROOM_IN_PROGRESS: '房间正在游戏中，暂时无法加入',
  NOT_IN_ROOM: '你当前不在任何房间中',
  BAD_PHASE: '当前阶段无法进行此操作',
  INVALID_WORD: '词需为 1–12 个字符',
  INVALID_SUBMIT_LIMIT: '填词时限只能是不限时 / 1 分钟 / 3 分钟 / 5 分钟',
  REPLACED: '你的连接已在别处打开，当前会话被顶替',
  OPPONENT_LEFT: '对手已离开房间',
  ROOM_DELETED: '房间已解散',
  INTERNAL: '服务器内部错误，请稍后重试',
};

export const constants = {
  COUNTDOWN_MS,
  START_DELAY,
  OFFLINE_ROOM_TTL_MS,
  SWEEP_INTERVAL_MS,
  DEFAULT_SUBMIT_MS,
  SUBMIT_LIMIT_OPTIONS,
  CODE_ALPHABET,
  CODE_RE,
  NAME_MAX,
  WORD_MAX,
  TIMEOUT_WORD,
} as const;

/* ==================== 内部数据模型（PROTOCOL.md §4，不下发） ==================== */

/** 本轮的提交（词 + 是否超时兜底） */
export interface Submission {
  word: string;
  timedOut: boolean;
}

export interface Player {
  token: string;
  name: string;
  seat: Seat;
  socketId: string | null;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** v2.1：本玩家是否已退出结算页（挂在玩家对象上，断线重连后仍保持） */
  settleDismissed: boolean;
}

/** v2.1：整局结束后的冻结快照，供未退出结算页的玩家继续 won 视角 */
export interface Snapshot {
  round: number;
  basis: Basis | null;
  history: HistoryItem[];
  result: Result | null;
  endedAt: number;
}

/** 内部同意词票；索引访问按 Seat 收窄 */
export type SeatMap<T> = { a: T; b: T };

export interface Room {
  code: string;
  phase: Phase;
  round: number;
  basis: Basis | null;
  players: Player[];
  submissions: SeatMap<Submission | null>;
  agree: AgreePair;
  /** 房间级填词时限（毫秒）：创建时确定，整局（含 restart / 换轮）不变；0 = 不限时 */
  submitLimitMs: SubmitLimitMs;
  lastGame: Snapshot | null;
  result: Result | null;
  history: HistoryItem[];
  /** 当前阶段唯一计时器 */
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
  createdAt: number;
  lastActivityAt: number;
  allOfflineAt: number | null;
}

/* ==================== 注入式传输层 ==================== */

/** 某个「服务端 → 客户端」事件对应的载荷类型 */
export type ServerPayload<E extends keyof ServerToClientEvents> = Parameters<
  ServerToClientEvents[E]
>[0];

export interface GameTransport {
  emitToRoom<E extends keyof ServerToClientEvents>(
    code: string,
    event: E,
    payload: ServerPayload<E>
  ): void;
  emitToPlayer<E extends keyof ServerToClientEvents>(
    player: Player,
    event: E,
    payload: ServerPayload<E>
  ): void;
  onSocketReplaced?(oldSocketId: string, room: Room, player: Player): void;
}

export type GameOptions = {
  emitToRoom?: GameTransport['emitToRoom'];
  emitToPlayer?: GameTransport['emitToPlayer'];
  onSocketReplaced?: NonNullable<GameTransport['onSocketReplaced']>;
};

/* ==================== 校验工具 ==================== */

/** 统一失败返回 */
function fail(code: ErrorCode): ActionError {
  return { ok: false, error: code, message: ERROR_MESSAGES[code] || '操作失败' };
}

/** 校验成功时的返回（value 为归一化后的入参） */
type Validated = { ok: true; value: string };
type Validation = Validated | ActionError;

/** 只接受字符串入参，其余一律视为空串（防止 undefined/null 打崩 normalizer） */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 以 Unicode 码点计长度（emoji 不会被算成 2 个字符） */
function charLength(value: string): number {
  return Array.from(value).length;
}

function validateName(raw: unknown): Validation {
  const name = asString(raw).trim();
  if (!name || charLength(name) > NAME_MAX) return fail('INVALID_NAME');
  return { ok: true, value: name };
}

function validateWord(raw: unknown): Validation {
  const word = asString(raw).trim();
  if (!word || charLength(word) > WORD_MAX) return fail('INVALID_WORD');
  return { ok: true, value: word };
}

function validateCode(raw: unknown): Validation {
  const code = asString(raw).trim().toUpperCase();
  if (!CODE_RE.test(code)) return fail('INVALID_CODE');
  return { ok: true, value: code };
}

function sanitizeToken(raw: unknown): string {
  const token = asString(raw).trim();
  if (!token || token.length > 128) return '';
  return token;
}

/**
 * 房间级填词时限（PROTOCOL.md §3）：创建时一次性选定，整局不变。
 * 缺省（undefined / null）沿用 DEFAULT_SUBMIT_MS；其余必须是 SUBMIT_LIMIT_OPTIONS 里的整数，
 * 否则 INVALID_SUBMIT_LIMIT（字符串 "60000"、90000 等一律拒绝）。
 */
type SubmitLimitValidation = { ok: true; value: SubmitLimitMs } | ActionError;

function validateSubmitLimit(raw: unknown): SubmitLimitValidation {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_SUBMIT_MS };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return fail('INVALID_SUBMIT_LIMIT');
  if (!(SUBMIT_LIMIT_OPTIONS as readonly number[]).includes(raw)) {
    return fail('INVALID_SUBMIT_LIMIT');
  }
  return { ok: true, value: raw as SubmitLimitMs };
}

/**
 * PROTOCOL.md §6 的判定归一化：
 * NFKC、小写、去掉空白 / 标点 / 符号。
 */
export function normalize(word: string): string {
  return String(word)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/* ==================== 状态机 ==================== */

export class Game {
  rooms: Map<string, Room>;

  emitToRoom: GameTransport['emitToRoom'];

  emitToPlayer: GameTransport['emitToPlayer'];

  onSocketReplaced: NonNullable<GameTransport['onSocketReplaced']>;

  sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(options: GameOptions = {}) {
    this.rooms = new Map(); // code -> Room
    this.emitToRoom = typeof options.emitToRoom === 'function' ? options.emitToRoom : () => {};
    this.emitToPlayer =
      typeof options.emitToPlayer === 'function' ? options.emitToPlayer : () => {};
    this.onSocketReplaced =
      typeof options.onSocketReplaced === 'function' ? options.onSocketReplaced : () => {};
    this.sweepTimer = null;
  }

  // ==================== 查询 / 生命周期 ====================

  roomCount(): number {
    return this.rooms.size;
  }

  roomCodeOf(socketId: string | null): string | null {
    const found = this._findBySocket(socketId);
    return found ? found.room.code : null;
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** 仅供进程退出 / 测试收尾使用：清空所有计时器与房间 */
  shutdown(): void {
    this.stopSweeper();
    for (const code of Array.from(this.rooms.keys())) this._deleteRoom(code);
  }

  // ==================== 客户端动作 ====================

  createRoom(
    socketId: string | null,
    payload: Partial<CreatePayload> = {}
  ): ActionResult<CreateOk> {
    const nameRes = validateName(payload.name);
    if (!nameRes.ok) return nameRes;
    const limitRes = validateSubmitLimit(payload.submitLimitMs);
    if (!limitRes.ok) return limitRes;

    const code = this._generateCode();
    const token = sanitizeToken(payload.token) || randomUUID();
    const player: Player = {
      token,
      name: nameRes.value,
      seat: 'a',
      socketId: socketId || null,
      ready: false,
      connected: true,
      isHost: true,
      settleDismissed: false, // v2.1：是否已退出结算页（PROTOCOL.md §5.3.1）
    };

    const room: Room = {
      code,
      phase: 'lobby',
      round: 1,
      basis: null,
      players: [player],
      submissions: { a: null, b: null },
      agree: { a: false, b: false }, // v2：本轮同意词投票（PROTOCOL.md §4）
      submitLimitMs: limitRes.value, // 房间级填词时限，创建时选定、整局不变
      result: null,
      history: [],
      lastGame: null, // v2.1：整局结束后的冻结快照，供未退出者继续 won 视角
      timer: null,
      deadline: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      allOfflineAt: null,
    };
    this.rooms.set(code, room);
    this.broadcastState(room);

    return { ok: true, code, token, seat: 'a' };
  }

  joinRoom(socketId: string | null, payload: Partial<JoinPayload> = {}): ActionResult<JoinOk> {
    const codeRes = validateCode(payload.code);
    if (!codeRes.ok) return codeRes;
    const code = codeRes.value;

    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND');

    // 1) token 命中已有玩家 —— 断线重连，任意 phase 都允许
    const token = sanitizeToken(payload.token);
    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        const oldSocketId = existing.socketId;
        existing.socketId = socketId || null;
        existing.connected = true;
        room.allOfflineAt = null;
        room.lastActivityAt = Date.now();
        if (oldSocketId && oldSocketId !== existing.socketId) {
          try {
            this.onSocketReplaced(oldSocketId, room, existing);
          } catch (err) {
            console.error('[game] onSocketReplaced 回调异常', err);
          }
        }
        this.broadcastState(room);
        return {
          ok: true,
          code: room.code,
          token: existing.token,
          seat: existing.seat,
          state: this.getState(room, existing),
        };
      }
    }

    // 2) 新玩家加入
    const nameRes = validateName(payload.name);
    if (!nameRes.ok) return nameRes;
    if (room.players.length >= 2) return fail('ROOM_FULL');
    if (room.phase !== 'lobby') return fail('ROOM_IN_PROGRESS');

    const occupied = new Set(room.players.map((p) => p.seat));
    const seat: Seat = occupied.has('a') ? 'b' : 'a';
    const player: Player = {
      token: randomUUID(),
      name: nameRes.value,
      seat,
      socketId: socketId || null,
      ready: false,
      connected: true,
      isHost: room.players.length === 0 || !room.players.some((p) => p.isHost),
      settleDismissed: false, // v2.1：新玩家从不属于上一局的结算页
    };
    room.players.push(player);
    // v2.1：新玩家加入同一房间 → 上一局的结算快照作废，没人该卡在假 won
    this._clearSettle(room);
    room.lastActivityAt = Date.now();
    room.allOfflineAt = null;

    this.broadcastState(room);
    this._emitRoom(room, 'room:notice', { text: `${player.name} 加入了房间`, kind: 'join' });

    return {
      ok: true,
      code: room.code,
      token: player.token,
      seat: player.seat,
      state: this.getState(room, player),
    };
  }

  leaveRoom(socketId: string | null): ActionResult<SimpleOk> {
    const found = this._findBySocket(socketId);
    if (!found) return fail('NOT_IN_ROOM');
    const { room, player } = found;

    this._clearTimer(room);
    const index = room.players.indexOf(player);
    if (index >= 0) room.players.splice(index, 1);
    // v2.1：留守结算页的人从自己的视角看「这局还没结束」，被丢下等同对局中离开
    const settleWatchers = room.lastGame ? room.players.filter((p) => !p.settleDismissed) : [];
    const wasPlaying =
      ['countdown', 'submitting', 'reveal'].includes(room.phase) || settleWatchers.length > 0;
    room.lastActivityAt = Date.now();
    // 快照不再适用于留在房间的人：清掉，避免有人卡在假 won
    this._clearSettle(room);

    if (room.players.length === 0) {
      this._deleteRoom(room.code);
      return { ok: true };
    }

    const remaining = room.players[0];
    if (player.isHost || !room.players.some((p) => p.isHost)) remaining.isHost = true;

    this._emitRoom(room, 'room:notice', { text: `${player.name} 离开了房间`, kind: 'leave' });

    if (wasPlaying) {
      room.phase = 'aborted';
      room.deadline = null;
      room.submissions = { a: null, b: null };
      this._emitPlayer(remaining, 'room:error', {
        code: 'OPPONENT_LEFT',
        message: ERROR_MESSAGES.OPPONENT_LEFT,
      });
    } else {
      room.submissions[player.seat] = null;
    }

    this.broadcastState(room);
    return { ok: true };
  }

  setReady(socketId: string | null, ready?: boolean): ActionResult<SimpleOk> {
    const found = this._findBySocket(socketId);
    if (!found) return fail('NOT_IN_ROOM');
    const { room, player } = found;
    if (room.phase !== 'lobby') return fail('BAD_PHASE');
    // v2.1：还留在结算页（未点「再来一局」）的人不允许准备，防陈旧/被改过的前端绕过
    if (room.lastGame && !player.settleDismissed) return fail('BAD_PHASE');

    player.ready = ready === undefined ? true : Boolean(ready);
    room.lastActivityAt = Date.now();
    this.broadcastState(room);

    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      this._scheduleStart(room);
    }
    return { ok: true };
  }

  submitWord(socketId: string | null, word?: string): ActionResult<SubmitOk> {
    const found = this._findBySocket(socketId);
    if (!found) return fail('NOT_IN_ROOM');
    const { room, player } = found;
    if (room.phase !== 'submitting') return fail('BAD_PHASE');

    // 已提交则幂等返回，且绝不改动已有内容
    if (room.submissions[player.seat]) return { ok: true, submitted: true };

    const wordRes = validateWord(word);
    if (!wordRes.ok) return wordRes;

    room.submissions[player.seat] = { word: wordRes.value, timedOut: false };
    room.lastActivityAt = Date.now();

    const opponent = room.players.find((p) => p.seat !== player.seat);
    if (opponent) {
      // 只提示「对方已提交」，载荷为空，绝不能带词
      this._emitPlayer(opponent, 'round:opponent-submitted', {});
    }
    this.broadcastState(room);

    if (room.players.length === 2 && room.submissions.a && room.submissions.b) {
      this._resolveRound(room);
    }

    return { ok: true, submitted: true };
  }

  /**
   * v2：本轮同意词投票（PROTOCOL.md §5.1）。
   * 仅 reveal 阶段有效；只记录票面，两票齐则通关（winBy='agree'）。
   * 投票不改变 reveal 的推进方式：reveal 永不自动推进，只能由 round:next 进入下一轮。
   * 返回 { ok, agree:{a,b}, winBy:'agree'|null }。
   */
  setAgree(socketId: string | null, agree?: boolean): ActionResult<AgreeOk> {
    const found = this._findBySocket(socketId);
    if (!found) return fail('NOT_IN_ROOM');
    const { room, player } = found;
    if (room.phase !== 'reveal') return fail('BAD_PHASE');

    const votes = this._agreeOf(room);
    const value = agree === undefined ? true : Boolean(agree);
    votes[player.seat] = value;
    room.lastActivityAt = Date.now();
    // result 同步反映本轮票面（两票齐之前 isWin / winBy 不变）
    if (room.result) room.result.agree = { a: Boolean(votes.a), b: Boolean(votes.b) };

    const ballot: AgreePair = { a: Boolean(votes.a), b: Boolean(votes.b) };

    if (!(votes.a && votes.b)) {
      this.broadcastState(room);
      return { ok: true, agree: ballot, winBy: null };
    }

    // 两票齐 -> 通关（由后到的那一票触发）
    this._clearTimer(room);
    room.deadline = null;
    room.phase = 'won';
    if (room.result) {
      room.result.isWin = true;
      room.result.winBy = 'agree';
      room.result.agree = { a: true, b: true };
    }
    const lastHistory = room.history[room.history.length - 1];
    if (lastHistory && lastHistory.round === room.round) {
      lastHistory.isWin = true;
      lastHistory.winBy = 'agree';
      lastHistory.agree = { a: true, b: true };
    }

    // 只发提示与状态，不重发 round:reveal（前端以 state 为准渲染 won）
    this._emitRoom(room, 'room:notice', { kind: 'system', text: '双方都确认是同意词，通关！' });
    this.broadcastState(room);
    return { ok: true, agree: { a: true, b: true }, winBy: 'agree' };
  }

  nextRound(socketId: string | null): ActionResult<SimpleOk> {
    const found = this._findBySocket(socketId);
    if (!found) return fail('NOT_IN_ROOM');
    if (found.room.phase !== 'reveal') return fail('BAD_PHASE');
    this._advanceRound(found.room);
    return { ok: true };
  }

  /**
   * v2.1（PROTOCOL.md §5.3.1）：「再来一局」= **本人**退出结算页。
   * 首次退出（内部 phase==='won'）先把整局冻结进 lastGame，再做与旧版一致的 lobby 重置；
   * 留守结算页的人继续看到 won 视角（含导出所需数据），直到 TA 自己也点「再来一局」。
   * ack：{ ok:true, watching } —— watching 表示是否还有别人留在结算页。
   */
  restart(socketId: string | null): ActionResult<RestartOk> {
    const found = this._findBySocket(socketId);
    if (!found) return fail('NOT_IN_ROOM');
    const { room, player } = found;
    // 合法相位：内部仍是 won，或「对方先点了、我还在看结算页」；已退出的人再点 -> BAD_PHASE
    const watching = Boolean(room.lastGame) && !player.settleDismissed;
    if (room.phase !== 'won' && !watching) return fail('BAD_PHASE');

    this._clearTimer(room);

    if (room.phase === 'won') {
      // 1) 冻结整局快照：history / result 形状与 §5.3 完全一致
      room.lastGame = {
        round: room.round,
        basis: room.basis ? { a: room.basis.a, b: room.basis.b } : null,
        history: this._publicHistory(room.history),
        result: this._publicResult(room.result),
        endedAt: Date.now(),
      };
      // 2) 房间内部照常重置为 lobby（与旧行为相同）
      room.phase = 'lobby';
      room.round = 1;
      room.basis = null;
      room.submissions = { a: null, b: null };
      room.agree = { a: false, b: false };
      room.result = null;
      room.history = [];
      room.deadline = null;
      room.lastActivityAt = Date.now();
      for (const p of room.players) {
        p.ready = false;
        p.settleDismissed = false;
      }
    }

    // 只有全部在场玩家都退出了，快照才真正作废
    player.settleDismissed = true;
    const staying = room.players.filter((p) => !p.settleDismissed);
    if (staying.length === 0) room.lastGame = null;

    // notice 改为定向：退出者 info，留守者 system
    this._emitPlayer(player, 'room:notice', { text: '已回到房间，可以再来一局', kind: 'info' });
    for (const p of staying) {
      this._emitPlayer(p, 'room:notice', {
        kind: 'system',
        text: '对方已经回到房间等你，看完点「再来一局」',
      });
    }
    this.broadcastState(room);
    return { ok: true, watching: staying.length > 0 };
  }

  disconnect(socketId: string): SimpleOk {
    const found = this._findBySocket(socketId);
    if (!found) return { ok: true };
    const { room, player } = found;
    // 已经被新连接顶替：旧 socket 的 disconnect 不能把新连接标记为离线
    if (player.socketId !== socketId) return { ok: true };

    player.connected = false;
    player.socketId = null;
    room.lastActivityAt = Date.now();
    if (room.players.every((p) => !p.connected)) room.allOfflineAt = Date.now();
    this.broadcastState(room);
    return { ok: true };
  }

  // ==================== 周期清理 ====================

  sweep(): void {
    const now = Date.now();
    for (const code of Array.from(this.rooms.keys())) {
      const room = this.rooms.get(code);
      if (!room) continue;
      if (room.players.length === 0) {
        this._deleteRoom(code);
        continue;
      }
      const allOffline = room.players.every((p) => !p.connected);
      if (allOffline && room.allOfflineAt && now - room.allOfflineAt >= OFFLINE_ROOM_TTL_MS) {
        this._deleteRoom(code);
      }
    }
  }

  // ==================== 视图 ====================

  /** 按接收者视角生成 PublicRoomState（PROTOCOL.md §5.3），永不含词 */
  getState(room: Room, player: Player) {
    const opponent = room.players.find((p) => p.seat !== player.seat) || null;
    const players = room.players
      .slice()
      .sort((x, y) => (x.seat < y.seat ? -1 : x.seat > y.seat ? 1 : 0))
      .map((p) => ({
        seat: p.seat,
        name: p.name,
        isHost: Boolean(p.isHost),
        ready: Boolean(p.ready),
        connected: Boolean(p.connected),
        isYou: p.seat === player.seat,
        settleDismissed: Boolean(p.settleDismissed),
      }));

    // v2.1（PROTOCOL.md §5.3.1）：整局已冻结 + 本人未退出结算页 => 继续看到 won 视角，
    // 数据全部取自 lastGame 快照；已退出的人看到真实房间状态。
    const settleView = Boolean(room.lastGame) && !player.settleDismissed ? room.lastGame : null;
    const inReveal = !settleView && room.phase === 'reveal';
    const votes = this._agreeOf(room);
    // PROTOCOL.md §5.3：reveal 阶段之外 agree 恒为 false
    const agreeView = {
      you: inReveal ? Boolean(votes[player.seat]) : false,
      opponent: opponent && inReveal ? Boolean(votes[opponent.seat]) : false,
    };

    return {
      code: room.code,
      phase: settleView ? 'won' : room.phase,
      round: settleView ? settleView.round : room.round,
      basis: this._publicBasis(settleView ? settleView.basis : room.basis),
      you: { seat: player.seat, name: player.name, isHost: Boolean(player.isHost) },
      players,
      submitted: settleView
        ? { you: false, opponent: false }
        : {
            you: Boolean(room.submissions[player.seat]),
            opponent: opponent ? Boolean(room.submissions[opponent.seat]) : false,
          },
      // v2.1：是否真有 lastGame 快照挂着（对所有视角一致）。前端锁定准备页必须
      // 同时要求 settlePending===true，否则新房会因为 settleDismissed 初值为 false 而永久锁死。
      settlePending: Boolean(room.lastGame),
      agree: settleView ? { you: false, opponent: false } : agreeView,
      // 房间级填词时限：对所有人（含结算快照视角）都下发同一个房间值
      submitLimitMs: room.submitLimitMs,
      deadline: settleView ? null : room.deadline == null ? null : room.deadline,
      result: settleView ? this._publicResult(settleView.result) : this._publicResult(room.result),
      history: this._publicHistory(settleView ? settleView.history : room.history),
    };
  }

  broadcastState(room: Room | null): void {
    if (!room) return;
    for (const player of room.players) {
      this._emitPlayer(player, 'room:state', this.getState(room, player));
    }
  }

  // ==================== 内部：状态机 ====================

  _scheduleStart(room: Room): void {
    if (room.phase !== 'lobby') return;
    this._setTimer(
      room,
      () => {
        if (room.phase !== 'lobby') return;
        if (room.players.length !== 2) return;
        if (!room.players.every((p) => p.ready)) return;
        this._startCountdown(room);
      },
      START_DELAY
    );
  }

  _startCountdown(room: Room): void {
    this._clearTimer(room);
    room.phase = 'countdown';
    room.submissions = { a: null, b: null };
    room.agree = { a: false, b: false };
    // v2.1 兜底：新一局已经开始，结算快照与「谁退过结算页」全部作废
    this._clearSettle(room);
    room.result = null;
    room.deadline = Date.now() + COUNTDOWN_MS;
    room.lastActivityAt = Date.now();

    this._emitRoom(room, 'round:countdown', {
      round: room.round,
      basis: room.basis,
      seconds: 3,
    });
    this.broadcastState(room);
    this._setTimer(room, () => this._openRound(room), COUNTDOWN_MS);
  }

  _openRound(room: Room): void {
    if (room.phase !== 'countdown') return;
    room.phase = 'submitting';
    // 不限时（submitLimitMs === 0）：deadline=null 且不设超时计时器，双方都提交才揭晓
    room.deadline = room.submitLimitMs > 0 ? Date.now() + room.submitLimitMs : null;
    room.lastActivityAt = Date.now();

    this._emitRoom(room, 'round:open', {
      round: room.round,
      basis: room.basis,
      deadline: room.deadline,
    });
    this.broadcastState(room);
    if (room.submitLimitMs > 0) {
      this._setTimer(room, () => this._onSubmitTimeout(room), room.submitLimitMs);
    }
  }

  _onSubmitTimeout(room: Room): void {
    if (room.phase !== 'submitting') return;
    for (const player of room.players) {
      if (!room.submissions[player.seat]) {
        room.submissions[player.seat] = { word: TIMEOUT_WORD, timedOut: true };
      }
    }
    this._resolveRound(room);
  }

  _resolveRound(room: Room): void {
    this._clearTimer(room);

    // 正常流程下始终是两名玩家；极端情况（例如对局中被移除）直接中止
    if (room.players.length !== 2) {
      room.phase = 'aborted';
      room.deadline = null;
      this._clearSettle(room); // v2.1：进入 aborted 相位，假 won 视角必须失效
      this.broadcastState(room);
      return;
    }

    const a = room.submissions.a || { word: TIMEOUT_WORD, timedOut: true };
    const b = room.submissions.b || { word: TIMEOUT_WORD, timedOut: true };
    room.submissions = { a, b };
    // 新一轮揭晓起点：票面清零（PROTOCOL.md §5.2）
    room.agree = { a: false, b: false };

    const words = { a: a.word, b: b.word };
    const normA = normalize(words.a);
    const normB = normalize(words.b);
    const isWin = normA !== '' && normA === normB;
    const timedOut = { a: Boolean(a.timedOut), b: Boolean(b.timedOut) };
    const winBy: WinBy | null = isWin ? 'same' : null;
    const agree: AgreePair = { a: false, b: false };
    const result: Result = { round: room.round, words, isWin, timedOut, agree, winBy };
    room.result = result;
    room.history.push({
      round: room.round,
      basis: room.basis ? { a: room.basis.a, b: room.basis.b } : null,
      words: { a: words.a, b: words.b },
      isWin,
      agree: { a: false, b: false },
      winBy,
    });
    room.lastActivityAt = Date.now();

    this._emitRoom(room, 'round:reveal', {
      round: room.round,
      basis: room.basis ? { a: room.basis.a, b: room.basis.b } : null,
      words: { a: words.a, b: words.b },
      isWin,
      timedOut: { a: timedOut.a, b: timedOut.b },
      agree: { a: false, b: false },
      winBy,
      history: this._publicHistory(room.history),
    });

    if (isWin) {
      room.phase = 'won';
      room.deadline = null;
      this.broadcastState(room);
      return;
    }

    // v3：非通关的 reveal 永不自动推进（没有 REVEAL_MS），只能由 round:next 进入下一轮
    room.phase = 'reveal';
    room.deadline = null;
    this.broadcastState(room);
  }

  /** 进入下一轮：basis = 上一轮的 words，round + 1，回到倒计时 */
  _advanceRound(room: Room): void {
    if (room.phase !== 'reveal') return;
    this._clearTimer(room);

    const previousWords = room.result ? room.result.words : null;
    room.basis = previousWords ? { a: previousWords.a, b: previousWords.b } : room.basis;
    room.round += 1;
    room.result = null;
    room.submissions = { a: null, b: null };
    room.agree = { a: false, b: false };
    room.phase = 'countdown';
    room.deadline = Date.now() + COUNTDOWN_MS;
    room.lastActivityAt = Date.now();

    this._emitRoom(room, 'round:countdown', {
      round: room.round,
      basis: room.basis,
      seconds: 3,
    });
    this.broadcastState(room);
    this._setTimer(room, () => this._openRound(room), COUNTDOWN_MS);
  }

  // ==================== 内部：工具 ====================

  /** 内部同意词票（对历史遗留 / 手工构造的房间做兜底，不新增对外字段） */
  _agreeOf(room: Room): AgreePair {
    if (!room.agree || typeof room.agree !== 'object') room.agree = { a: false, b: false };
    room.agree.a = Boolean(room.agree.a);
    room.agree.b = Boolean(room.agree.b);
    return room.agree;
  }

  _generateCode(): string {
    for (let attempt = 0; attempt < 5000; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('无法生成唯一房间码');
  }

  _findBySocket(socketId: string | null): { room: Room; player: Player } | null {
    if (!socketId) return null;
    for (const room of this.rooms.values()) {
      for (const player of room.players) {
        if (player.socketId && player.socketId === socketId) return { room, player };
      }
    }
    return null;
  }

  _publicHistory(items: HistoryItem[]): HistoryItem[] {
    const list = Array.isArray(items) ? items : [];
    return list.map((item) => ({
      round: item.round,
      basis: item.basis ? { a: item.basis.a, b: item.basis.b } : null,
      words: { a: item.words.a, b: item.words.b },
      isWin: Boolean(item.isWin),
      agree: item.agree
        ? { a: Boolean(item.agree.a), b: Boolean(item.agree.b) }
        : { a: false, b: false },
      winBy: item.winBy === 'same' || item.winBy === 'agree' ? item.winBy : null,
    }));
  }

  /** §5.3 的 result 形状；对已是公开形状的对象幂等，故 lastGame 快照可直接复用 */
  _publicResult(result: Result | null): Result | null {
    if (!result) return null;
    return {
      round: result.round,
      words: { a: result.words.a, b: result.words.b },
      isWin: Boolean(result.isWin),
      timedOut: {
        a: Boolean(result.timedOut.a),
        b: Boolean(result.timedOut.b),
      },
      agree: result.agree
        ? { a: Boolean(result.agree.a), b: Boolean(result.agree.b) }
        : { a: false, b: false },
      winBy: result.winBy === 'same' || result.winBy === 'agree' ? result.winBy : null,
    };
  }

  _publicBasis(basis: Basis | null): Basis | null {
    return basis ? { a: basis.a, b: basis.b } : null;
  }

  /** v2.1：结算快照作废——留在房间的在场玩家都不该卡在假 won */
  _clearSettle(room: Room | null): void {
    if (!room) return;
    room.lastGame = null;
    for (const p of room.players) p.settleDismissed = false;
  }

  _emitRoom<E extends keyof ServerToClientEvents>(
    room: Room | null,
    event: E,
    payload: ServerPayload<E>
  ): void {
    if (!room) return;
    this.emitToRoom(room.code, event, payload);
  }

  _emitPlayer<E extends keyof ServerToClientEvents>(
    player: Player | null,
    event: E,
    payload: ServerPayload<E>
  ): void {
    if (!player || !player.socketId) return;
    this.emitToPlayer(player, event, payload);
  }

  _clearTimer(room: Room | null): void {
    if (room && room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
  }

  /** 同一房间同一时刻只允许一个计时器 */
  _setTimer(room: Room, fn: () => void, ms: number): void {
    this._clearTimer(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      try {
        fn();
      } catch (err) {
        console.error('[game] 计时器回调异常', err);
      }
    }, ms);
  }

  _deleteRoom(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    this._clearTimer(room);
    this._clearSettle(room); // v2.1：sweep / 0 人删房时一并作废结算快照
    this.rooms.delete(code);
    return true;
  }
}

export default Game;
