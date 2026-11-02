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

export type ErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_CODE'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_IN_PROGRESS'
  | 'NOT_IN_ROOM'
  | 'BAD_PHASE'
  | 'INVALID_WORD'
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
  revealFrozen: boolean;
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

/* ==================== 请求载荷 ==================== */

export interface CreatePayload {
  name: string;
  token?: string;
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
  deadline: number;
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
