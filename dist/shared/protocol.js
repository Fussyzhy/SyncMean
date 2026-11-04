/**
 * 前后端共享协议类型 —— PROTOCOL.md §5 的 TypeScript 映射。
 *
 * 事实来源仍是 PROTOCOL.md：字段名、事件名、错误码一律不得擅自改动。
 * 本文件只做类型声明，不含任何运行时依赖（server 编译与 web 打包都会引用它）。
 */
/* ==================== 房间级时间参数（创建房间时由房主设定） ==================== */
/**
 * 填词时限可选项（毫秒）。`0` 表示不限时：round:open 的 deadline 为 null，
 * 服务端不设超时计时器，必须双方都提交才会揭晓。
 * 创建时一次性选定，整局（含 game:restart 重开）保持不变。
 */
export const SUBMIT_LIMIT_OPTIONS = [0, 60000, 180000, 300000];
/** 请求里未指定 submitLimitMs 时（含旧客户端）使用 1 分钟，与历史行为一致 */
export const DEFAULT_SUBMIT_MS = 60000;
/* ==================== v3.6：玩家互动（戳一戳 / 扔番茄 / 倒咖啡） ==================== */
/**
 * 互动白名单。只允许预设值，**不接受自由文本**：
 * 否则会变成双盲提交阶段的暗示通道（见 PROTOCOL.md §5.1）。
 * 三种互动都是纯玩法/情绪表达，服务端不解释语义，只负责白名单校验 + 1s 限流 + 定向转发。
 */
export const INTERACT_KINDS = ['poke', 'tomato', 'coffee'];
/* ==================== v3.7：语音连麦（P2P，服务器只转发信令） ==================== */
/**
 * 信令类型白名单。服务器**不解析 data 内容**、不落盘、不参与媒体转发：
 * - `offer` / `answer`：SDP 文本（`RTCPeerConnection.localDescription.sdp`）；
 * - `ice`：单条 ICE candidate 的 JSON 字符串（`JSON.stringify(candidate)`，空候选用 `''`）。
 */
export const VOICE_SIGNAL_KINDS = ['offer', 'answer', 'ice'];
/** 单条信令 `data` 的最大字符数（服务端校验，防滥用；正常 SDP 约 2–4KB） */
export const VOICE_SIGNAL_MAX_CHARS = 16384;
/* ==================== 客户端 → 服务端事件名 ==================== */
export const CLIENT_EVENTS = [
    'room:create',
    'room:join',
    'room:leave',
    'player:ready',
    'round:submit',
    'round:agree',
    'round:next',
    'room:interact',
    'voice:state',
    'voice:signal',
    'game:end',
    'game:restart',
];
export const SERVER_EVENTS = [
    'room:state',
    'round:countdown',
    'round:open',
    'round:opponent-submitted',
    'round:reveal',
    'room:notice',
    'room:interacted',
    'voice:signal',
    'room:error',
];
//# sourceMappingURL=protocol.js.map