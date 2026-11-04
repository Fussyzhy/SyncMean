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
/* ==================== 常量 ==================== */
/** 管理员命名空间（同源，dev 由 vite proxy 转发 /socket.io） */
export const ADMIN_NAMESPACE = '/admin';
/** 握手鉴权失败时的 connect_error message（客户端据此区分「密钥错误」与网络问题） */
export const ADMIN_AUTH_ERROR = 'ADMIN_AUTH_FAILED';
/** 同一 IP 连续试错过多时的 connect_error message */
export const ADMIN_RATE_LIMIT_ERROR = 'ADMIN_RATE_LIMITED';
//# sourceMappingURL=admin.js.map