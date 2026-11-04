/**
 * 管理后台协议（v3.5，PROTOCOL.md §14）—— 前后端共享类型。
 *
 * 与玩家协议（src/shared/protocol.ts）完全隔离：
 * - 管理员走独立的 Socket.IO **namespace `/admin`**，不进入任何房间频道，
 *   因此观战、踢房都不会影响玩家对局（不会占座、不会触发「对方离开」）。
 * - 密钥只放在服务端进程环境变量 `ADMIN_KEY`（本地由 `.env` 读取）；
 *   客户端在握手 `auth: { key }` 里携带，服务端校验失败直接拒绝连接。
 * - 本文件只做类型声明，不含任何运行时依赖（server 编译与 web 打包都会引用它）。
 */

import type { Ack, AgreePair, ActionResult, Basis, HistoryItem, Phase, Result, Seat } from './protocol.js';

/* ==================== 常量 ==================== */

/** 管理员命名空间（同源，dev 由 vite proxy 转发 /socket.io） */
export const ADMIN_NAMESPACE = '/admin';

/** 握手鉴权失败时的 connect_error message（客户端据此区分「密钥错误」与网络问题） */
export const ADMIN_AUTH_ERROR = 'ADMIN_AUTH_FAILED';

/** 同一 IP 连续试错过多时的 connect_error message */
export const ADMIN_RATE_LIMIT_ERROR = 'ADMIN_RATE_LIMITED';

/* ==================== 房间列表 / 观战数据形状 ==================== */

/** 房间成员的管理员视角：只含公开信息，不含 token / 词 */
export interface AdminRoomPlayer {
  seat: Seat;
  name: string;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  /** 本次离线开始时刻（毫秒时间戳）；在线为 null */
  offlineAt: number | null;
}

/** 房间列表行（实时推送 + 请求响应共用同一形状） */
export interface AdminRoomSummary {
  code: string;
  /** 房间真实相位；结算快照挂起时仍为 lobby，前端可用 settlePending 显示「结算中」 */
  phase: Phase;
  round: number;
  players: AdminRoomPlayer[];
  playerCount: number;
  onlineCount: number;
  /** 房间级填词时限（毫秒）；0 = 不限时 */
  submitLimitMs: number;
  /** v3.7：建房时房主是否开启语音连麦（房间级参数，整局不变） */
  voice: boolean;
  /** countdown = 倒计时结束时刻；submitting = 提交截止（不限时为 null）；其余为 null */
  deadline: number | null;
  createdAt: number;
  lastActivityAt: number;
  /** 是否挂着整局结算快照（lastGame） */
  settlePending: boolean;
}

/** 当前房间总数 / 玩家总数统计（列表头部展示用） */
export interface AdminRoomsPayload {
  rooms: AdminRoomSummary[];
  /** 服务端生成时刻（毫秒）：前端据此换算 deadline 剩余时间，避免手机与服务器时钟不一致 */
  at: number;
  totalRooms: number;
  totalPlayers: number;
}

/** 单个房间的完整观战视角（实时推送） */
export interface AdminRoomDetail extends AdminRoomSummary {
  /** 本轮联想依据（揭晓前为上一轮结果，公开信息） */
  basis: Basis | null;
  /** 双方是否已提交（**只暴露布尔值，绝不提前下发词**，与玩家协议 §5.3 一致） */
  submitted: AgreePair;
  /** 本轮同意词投票（仅 reveal 阶段为真实值，其余恒 false，与玩家协议一致） */
  agree: AgreePair;
  /** 本轮结果；未揭晓为 null。结算快照挂起时取 lastGame.result */
  result: Result | null;
  /** 历史轮次（含词），结算快照挂起时取 lastGame.history */
  history: HistoryItem[];
  /** 整局结算快照的冻结时刻；没有快照为 null */
  settleEndedAt: number | null;
}

/* ==================== 请求载荷 ==================== */

export interface AdminWatchPayload {
  code: string;
}

export interface AdminUnwatchPayload {
  code: string;
}

export interface AdminDeleteRoomPayload {
  code: string;
}

export interface AdminRoomsRequestPayload {
  /** 预留：true 表示只看进行中的房间（后端当前忽略，保留扩展位） */
  activeOnly?: boolean;
}

/* ==================== ack 结果 ==================== */

/** 终止并删除房间成功：返回被删房间码（大写） */
export interface AdminDeleteOk {
  ok: true;
  code: string;
}

/** 开始观战成功：立即拿到一份当前快照（后续靠 admin:room:state 增量推送） */
export interface AdminWatchOk {
  ok: true;
  detail: AdminRoomDetail;
}

export interface AdminSimpleOk {
  ok: true;
}

/* ==================== 服务端 → 管理员 ==================== */

export interface AdminRoomStatePayload {
  code: string;
  detail: AdminRoomDetail;
  at: number;
}

/** 被观战房间消失（管理员删除、自然清理、玩家走光） */
export interface AdminRoomClosedPayload {
  code: string;
  reason: 'deleted' | 'expired';
}

/** `admin:rooms:request` 的 ack 成功载荷（包一层 ok，与其他 ack 约定一致） */
export interface AdminRoomsOk {
  ok: true;
  rooms: AdminRoomsPayload;
}

export interface AdminServerToClientEvents {
  /** 房间列表实时快照（变化时才推，通常 ≤500ms 内到达） */
  'admin:rooms': (payload: AdminRoomsPayload) => void;
  /** 被观战房间的实时状态（内容变化时才推） */
  'admin:room:state': (payload: AdminRoomStatePayload) => void;
  /** 被观战房间已不存在 */
  'admin:room:closed': (payload: AdminRoomClosedPayload) => void;
}

/* ==================== 管理员 → 服务端 ==================== */

export interface AdminClientToServerEvents {
  /** 主动拉一次房间列表（连接成功时用；日常靠服务端推送） */
  'admin:rooms:request': (
    payload: AdminRoomsRequestPayload,
    ack?: Ack<ActionResult<AdminRoomsOk>>
  ) => void;
  /** 开始观战某个房间 */
  'admin:room:watch': (
    payload: AdminWatchPayload,
    ack?: Ack<ActionResult<AdminWatchOk>>
  ) => void;
  /** 停止观战 */
  'admin:room:unwatch': (
    payload: AdminUnwatchPayload,
    ack?: Ack<ActionResult<AdminSimpleOk>>
  ) => void;
  /** 终止并删除房间（房间内玩家会收到 room:error {code:'ROOM_DELETED'}） */
  'admin:room:delete': (
    payload: AdminDeleteRoomPayload,
    ack?: Ack<ActionResult<AdminDeleteOk>>
  ) => void;
}

/* ==================== 运行时辅助 ==================== */

/**
 * 管理员握手 auth 载荷。
 * 注意：`key` 是明文密钥，只走 socket 握手（同源、生产应在 HTTPS 反代之后），
 * 前端仅保存在 sessionStorage（关标签页即失效），禁止写 localStorage / URL。
 */
export interface AdminHandshakeAuth {
  key: string;
}

/** 每个已鉴权管理员 socket 的服务端侧数据 */
export interface AdminSocketData {
  /** 该管理员当前正在观战的房间码集合（服务端维护，断线即失效） */
  watched: Set<string>;
}
