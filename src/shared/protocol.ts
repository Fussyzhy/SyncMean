/**
 * 前后端共享协议类型 —— PROTOCOL.md §5 的 TypeScript 映射。
 *
 * 事实来源仍是 PROTOCOL.md：字段名、事件名、错误码一律不得擅自改动。
 * 本文件只做类型声明，不含任何运行时依赖（server 编译与 web 打包都会引用它）。
 */

/* ==================== 基础枚举 ==================== */

export type Seat = 'a' | 'b';

export type Phase = 'lobby' | 'countdown' | 'submitting' | 'reveal' | 'won' | 'aborted';

export type WinBy = 'same' | 'agree';

/* ==================== 房间级时间参数（创建房间时由房主设定） ==================== */

/**
 * 填词时限可选项（毫秒）。`0` 表示不限时：round:open 的 deadline 为 null，
 * 服务端不设超时计时器，必须双方都提交才会揭晓。
 * 创建时一次性选定，整局（含 game:restart 重开）保持不变。
 */
export const SUBMIT_LIMIT_OPTIONS = [0, 60000, 180000, 300000] as const;

export type SubmitLimitMs = (typeof SUBMIT_LIMIT_OPTIONS)[number];

/** 请求里未指定 submitLimitMs 时（含旧客户端）使用 1 分钟，与历史行为一致 */
export const DEFAULT_SUBMIT_MS: SubmitLimitMs = 60000;

/* ==================== v3.4：预设快捷表情 ==================== */

/**
 * 快捷表情白名单。只允许预设值，**不接受自由文本**：
 * 否则会变成双盲提交阶段的暗示通道（见 PROTOCOL.md §5.1）。
 */
export const EMOTE_KINDS = ['nudge', 'thinking', 'cheer'] as const;

export type EmoteKind = (typeof EMOTE_KINDS)[number];

export type ErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_CODE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_IN_PROGRESS'
  | 'NOT_IN_ROOM'
  | 'BAD_PHASE'
  | 'INVALID_WORD'
  | 'INVALID_SUBMIT_LIMIT'
  | 'INVALID_EMOTE'
  | 'REPLACED'
  | 'OPPONENT_LEFT'
  | 'ROOM_DELETED'
  | 'INTERNAL';

/** 会话级错误（room:error 事件）只用到这三个 */
export type RoomLevelErrorCode = 'OPPONENT_LEFT' | 'REPLACED' | 'ROOM_DELETED';

export type NoticeKind = 'join' | 'leave' | 'info' | 'system';

/* ==================== 数据形状（§5.3） ==================== */

export interface Words {
  a: string;
  b: string;
}

export interface Basis {
  a: string;
  b: string;
}

export interface AgreePair {
  a: boolean;
  b: boolean;
}

export interface TimedOut {
  a: boolean;
  b: boolean;
}

export interface Result {
  round: number;
  words: Words;
  isWin: boolean;
  timedOut: TimedOut;
  agree: AgreePair;
  winBy: WinBy | null;
}

export interface HistoryItem {
  round: number;
  basis: Basis | null;
  words: Words;
  isWin: boolean;
  agree: AgreePair;
  winBy: WinBy | null;
}

export interface PublicPlayer {
  seat: Seat;
  name: string;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  isYou: boolean;
  settleDismissed: boolean;
}

/** 前端渲染的唯一依据，永不含未揭晓的词 */
export interface PublicRoomState {
  code: string;
  phase: Phase;
  round: number;
  basis: Basis | null;
  you: { seat: Seat; name: string; isHost: boolean };
  players: PublicPlayer[];
  submitted: { you: boolean; opponent: boolean };
  settlePending: boolean;
  agree: { you: boolean; opponent: boolean };
  /** 本房间填词时限（毫秒），创建时由房主设定；0 = 不限时 */
  submitLimitMs: number;
  /** countdown = 倒计时结束时刻；submitting = 提交截止（不限时为 null）；reveal = null（不再自动推进） */
  deadline: number | null;
  result: Result | null;
  history: HistoryItem[];
}

/* ==================== ack 结果（§5.1） ==================== */

export interface ActionError {
  ok: false;
  error: ErrorCode;
  message: string;
}

export type ActionResult<T> = T | ActionError;

export interface CreateOk {
  ok: true;
  code: string;
  token: string;
  seat: Seat;
}

export interface JoinOk {
  ok: true;
  code: string;
  token: string;
  seat: Seat;
  state: PublicRoomState;
}

export interface SimpleOk {
  ok: true;
}

export interface SubmitOk {
  ok: true;
  submitted: true;
}

export interface AgreeOk {
  ok: true;
  agree: AgreePair;
  winBy: 'agree' | null;
}

export interface RestartOk {
  ok: true;
  /** 是否还有别人留在结算页 */
  watching: boolean;
}

/** v3.4：快捷表情 ack。accepted=false 表示冷却中或对方离线，未送达 */
export interface EmoteOk {
  ok: true;
  accepted: boolean;
}

/* ==================== 请求载荷 ==================== */

export interface CreatePayload {
  name: string;
  token?: string;
  /** 填词时限；缺省用 DEFAULT_SUBMIT_MS，非法值返回 INVALID_SUBMIT_LIMIT */
  submitLimitMs?: SubmitLimitMs;
}

export interface JoinPayload {
  code: string;
  name?: string;
  token?: string;
}

export interface ReadyPayload {
  ready?: boolean;
}

export interface SubmitPayload {
  word: string;
}

export interface AgreePayload {
  agree?: boolean;
}

/** v3.4：快捷表情请求；kind 必须在 EMOTE_KINDS 内，否则 INVALID_EMOTE */
export interface EmotePayload {
  kind: EmoteKind;
}

/** 无载荷事件统一用它（socket.io 要求至少一个参数） */
export type EmptyPayload = Record<string, never>;

/* ==================== 服务端 → 客户端载荷 ==================== */

export interface CountdownPayload {
  round: number;
  basis: Basis | null;
  seconds: number;
}

export interface RoundOpenPayload {
  round: number;
  basis: Basis | null;
  /** 提交截止时刻；本房间为「不限时」时为 null */
  deadline: number | null;
}

export interface RevealPayload {
  round: number;
  basis: Basis | null;
  words: Words;
  isWin: boolean;
  timedOut: TimedOut;
  agree: AgreePair;
  winBy: WinBy | null;
  history: HistoryItem[];
}

export interface NoticePayload {
  text: string;
  kind: NoticeKind;
}

export interface RoomErrorPayload {
  code: RoomLevelErrorCode;
  message: string;
}

/* ==================== socket.io 事件表 ==================== */

export type Ack<T> = (result: T) => void;

export interface ClientToServerEvents {
  'room:create': (payload: CreatePayload, ack?: Ack<ActionResult<CreateOk>>) => void;
  'room:join': (payload: JoinPayload, ack?: Ack<ActionResult<JoinOk>>) => void;
  'room:leave': (payload?: EmptyPayload, ack?: Ack<ActionResult<SimpleOk>>) => void;
  'player:ready': (payload?: ReadyPayload, ack?: Ack<ActionResult<SimpleOk>>) => void;
  'round:submit': (payload: SubmitPayload, ack?: Ack<ActionResult<SubmitOk>>) => void;
  'round:agree': (payload?: AgreePayload, ack?: Ack<ActionResult<AgreeOk>>) => void;
  'round:next': (payload?: EmptyPayload, ack?: Ack<ActionResult<SimpleOk>>) => void;
  'room:emote': (payload: EmotePayload, ack?: Ack<ActionResult<EmoteOk>>) => void;
  'game:end': (payload?: EmptyPayload, ack?: Ack<ActionResult<SimpleOk>>) => void;
  'game:restart': (payload?: EmptyPayload, ack?: Ack<ActionResult<RestartOk>>) => void;
}

export interface ServerToClientEvents {
  'room:state': (state: PublicRoomState) => void;
  'round:countdown': (payload: CountdownPayload) => void;
  'round:open': (payload: RoundOpenPayload) => void;
  'round:opponent-submitted': (payload: EmptyPayload) => void;
  'round:reveal': (payload: RevealPayload) => void;
  'room:notice': (payload: NoticePayload) => void;
  'room:error': (payload: RoomErrorPayload) => void;
}

/** 只有本进程内广播，不跨节点（PROTOCOL.md §README：禁止多副本） */
export type InterServerEvents = Record<string, never>;

export interface SocketData {
  roomCode?: string;
}

/* ==================== 客户端 → 服务端事件名 ==================== */

export const CLIENT_EVENTS = [
  'room:create',
  'room:join',
  'room:leave',
  'player:ready',
  'round:submit',
  'round:agree',
  'round:next',
  'room:emote',
  'game:end',
  'game:restart',
] as const satisfies readonly (keyof ClientToServerEvents)[];

export const SERVER_EVENTS = [
  'room:state',
  'round:countdown',
  'round:open',
  'round:opponent-submitted',
  'round:reveal',
  'room:notice',
  'room:error',
] as const satisfies readonly (keyof ServerToClientEvents)[];
