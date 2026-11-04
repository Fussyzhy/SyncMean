/**
 * 同声传意 —— 管理后台命名空间（v3.5，PROTOCOL.md §14）
 *
 * 独立挂在 Socket.IO 的 `/admin` namespace 上，与玩家命名空间完全隔离：
 * - 管理员 socket **永远不 join 任何 `room_*` 频道**，观战 / 终止房间不会占座、
 *   不会触发 `room:notice` / `OPPONENT_LEFT` / `room:state` 广播；
 * - 握手 `auth: { key }` 用 sha256 + `timingSafeEqual` 做定时安全比较；
 *   同一 IP 60 秒内失败 ≥ 10 次后返回 `ADMIN_RATE_LIMITED`（窗口内即使密钥正确也先拒绝）；
 * - 房间列表 / 观战详情每 500ms 计算一次，**内容变化才推**；没有管理员连接时不空转
 *   （interval 在首个管理员连上时启动、最后一个断开时停止，且 unref）。
 *
 * 只读约束（§14.2）：观战视角沿用玩家 §5.3 的数据边界——`submitted` 只下发布尔值，
 * 揭晓前任何载荷都不含词；也绝不伪造 / 发送任何玩家事件。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { ADMIN_AUTH_ERROR, ADMIN_NAMESPACE, ADMIN_RATE_LIMIT_ERROR, } from '../shared/admin.js';
import { constants, ERROR_MESSAGES } from './game.js';
import { ADMIN_ENABLED, ADMIN_KEY } from './env.js';
/* ==================== 常量 ==================== */
/** 房间列表 / 观战详情的检查周期（§14.2：≤500ms） */
const PUSH_INTERVAL_MS = 500;
/** 同一 IP 的鉴权失败计数窗口 */
const AUTH_FAILURE_WINDOW_MS = 60 * 1000;
/** 窗口内失败达到该次数后一律先拒绝（即使密钥正确） */
const AUTH_FAILURE_LIMIT = 10;
/** 鉴权失败记录表过大时清理过期项的阈值（防恶意 IP 撑爆内存） */
const AUTH_FAILURE_MAP_MAX = 2048;
/* ==================== 小工具 ==================== */
/** 统一失败返回（错误码与玩家协议一致，message 复用 game.ts 的中文文案） */
function fail(code) {
    return { ok: false, error: code, message: ERROR_MESSAGES[code] || '操作失败' };
}
/** 兜住事件处理异常，保证 ack 一定有结果 */
function safeResult(fn) {
    try {
        return fn();
    }
    catch (err) {
        console.error('[同声传意][admin] 事件处理异常', err);
        return fail('INTERNAL');
    }
}
/** ack 统一回复（客户端可能不传回调） */
function respond(ack, result) {
    if (typeof ack !== 'function')
        return;
    try {
        ack(result);
    }
    catch (err) {
        console.error('[同声传意][admin] ack 回调异常', err);
    }
}
/**
 * 管理员事件参数归一：正常是 `(payload, ack)`；客户端也可能省略载荷只传 ack，
 * 与玩家侧 handler 的容错口径保持一致。
 */
function splitAdminArgs(payload, ack) {
    if (typeof payload === 'function' && ack === undefined) {
        return { payload: undefined, ack: payload };
    }
    return { payload, ack };
}
/** 从任意请求载荷里取 `code`（非对象 / 缺字段一律返回 undefined，交给格式校验） */
function readCode(payload) {
    if (!payload || typeof payload !== 'object')
        return undefined;
    return payload.code;
}
/**
 * 房间码归一化（与 game.ts 的 validateCode 同语义）：
 * 去首尾空白、转大写，必须匹配 4 位字符集 A-Z2-9。
 * 这里复用 game.ts 导出的 CODE_RE 常量，不另写一份字符集。
 */
function normalizeCode(raw) {
    if (typeof raw !== 'string')
        return null;
    const code = raw.trim().toUpperCase();
    return constants.CODE_RE.test(code) ? code : null;
}
/** 客户端握手 IP（单进程直连场景足够；反代下同一 IP 的限流按反代出口计） */
function clientIpOf(socket) {
    const address = socket.handshake.address;
    return typeof address === 'string' && address ? address : 'unknown';
}
/** 列表内容签名：不含 `at`（服务端时刻每次不同，否则会被误判为「变化」） */
function signatureOf(rooms) {
    return JSON.stringify(rooms);
}
/* ==================== 装配 ==================== */
/**
 * 创建 `/admin` 命名空间并接线四个管理员事件。
 *
 * @param io Socket.IO 服务器（默认玩家命名空间的实例）
 * @param game 房间 / 对局状态机（只读查询 + adminDeleteRoom）
 */
export function attachAdmin(io, game) {
    const namespace = io.of(ADMIN_NAMESPACE);
    /** 每个管理员 socket 上次推送过的「房间码 -> detail JSON」；断线即清理 */
    const watcherSignatures = new Map();
    /** 鉴权失败时刻：ip -> 时间戳列表（60s 滑动窗口限流） */
    const authFailures = new Map();
    /** 上次广播给所有管理员的房间列表内容签名；无管理员连接时重置为 null */
    let lastRoomsSignature = null;
    /** 500ms 检查定时器；无管理员时为空 */
    let tickTimer = null;
    /** dispose 后不再接受新的管理员连接 */
    let disposed = false;
    /** 预计算的密钥摘要（密钥只来自 env.ts，绝不打日志） */
    const expectedKeyDigest = createHash('sha256').update(ADMIN_KEY, 'utf8').digest();
    // ---------- 鉴权 ----------
    /** 定时安全比较：始终比较两个等长 sha256 摘要，避免按字符提前返回泄露时序 */
    function verifyKey(provided) {
        const providedDigest = createHash('sha256')
            .update(typeof provided === 'string' ? provided : '', 'utf8')
            .digest();
        const same = timingSafeEqual(expectedKeyDigest, providedDigest);
        return ADMIN_ENABLED && typeof provided === 'string' && same;
    }
    /** 取该 IP 在窗口内的失败时刻（顺手清理过期项） */
    function recentFailures(ip, now) {
        const list = (authFailures.get(ip) || []).filter((at) => now - at < AUTH_FAILURE_WINDOW_MS);
        if (list.length === 0)
            authFailures.delete(ip);
        else
            authFailures.set(ip, list);
        return list;
    }
    function recordFailure(ip, now) {
        const list = recentFailures(ip, now);
        list.push(now);
        authFailures.set(ip, list);
        if (authFailures.size <= AUTH_FAILURE_MAP_MAX)
            return;
        // 极端情况下（大量不同 IP）整体清理过期项，避免 Map 无界增长
        for (const [key, times] of authFailures) {
            const alive = times.filter((at) => now - at < AUTH_FAILURE_WINDOW_MS);
            if (alive.length === 0)
                authFailures.delete(key);
            else
                authFailures.set(key, alive);
        }
    }
    namespace.use((socket, next) => {
        if (disposed) {
            next(new Error(ADMIN_AUTH_ERROR));
            return;
        }
        const ip = clientIpOf(socket);
        const now = Date.now();
        // §14.1：窗口内失败 ≥ 10 次后，即使密钥正确也先拒绝
        if (recentFailures(ip, now).length >= AUTH_FAILURE_LIMIT) {
            next(new Error(ADMIN_RATE_LIMIT_ERROR));
            return;
        }
        if (!verifyKey(socket.handshake.auth?.key)) {
            recordFailure(ip, now);
            next(new Error(ADMIN_AUTH_ERROR));
            return;
        }
        next();
    });
    // ---------- 房间列表 / 观战快照 ----------
    function makeRoomsPayload(rooms, at) {
        return {
            rooms,
            at,
            totalRooms: rooms.length,
            totalPlayers: rooms.reduce((sum, room) => sum + room.playerCount, 0),
        };
    }
    /** 列表内容变化才广播（§14.2）；返回是否推送 */
    function pushRoomsIfChanged(now) {
        const rooms = game.listRooms();
        const signature = signatureOf(rooms);
        if (signature === lastRoomsSignature)
            return;
        lastRoomsSignature = signature;
        namespace.emit('admin:rooms', makeRoomsPayload(rooms, now));
    }
    /**
     * 被观战房间消失：通知所有正在观战它的管理员（§14.2），随后自动移出观战集合。
     * reason：'deleted' = 管理员终止；'expired' = 自然清理 / 玩家走光。
     */
    function closeWatchedRoom(code, reason) {
        for (const socket of namespace.sockets.values()) {
            const signatures = watcherSignatures.get(socket.id);
            if (!signatures || !signatures.has(code))
                continue;
            signatures.delete(code);
            socket.data.watched.delete(code);
            socket.emit('admin:room:closed', { code, reason });
        }
    }
    /** 每 500ms 一次：列表 + 每个管理员的观战详情，内容变化才推 */
    function tick() {
        try {
            if (namespace.sockets.size === 0) {
                stopTicker();
                return;
            }
            const now = Date.now();
            pushRoomsIfChanged(now);
            for (const socket of namespace.sockets.values()) {
                const signatures = watcherSignatures.get(socket.id);
                if (!signatures || signatures.size === 0)
                    continue;
                for (const code of Array.from(signatures.keys())) {
                    const room = game.rooms.get(code);
                    if (!room) {
                        // 房间已经不存在（sweep 清理 / 玩家走光 / 被删）：推 closed 并停止观战
                        signatures.delete(code);
                        socket.data.watched.delete(code);
                        socket.emit('admin:room:closed', { code, reason: 'expired' });
                        continue;
                    }
                    const detail = game.getSpectatorState(room);
                    const signature = JSON.stringify(detail);
                    // 同一内容不重复推（§14.2）
                    if (signature === signatures.get(code))
                        continue;
                    signatures.set(code, signature);
                    socket.emit('admin:room:state', { code, detail, at: now });
                }
            }
        }
        catch (err) {
            // 推送循环不能因为单个房间的异常把定时器打挂
            console.error('[同声传意][admin] 推送循环异常', err);
        }
    }
    function startTicker() {
        if (tickTimer)
            return;
        tickTimer = setInterval(tick, PUSH_INTERVAL_MS);
        // 不阻止进程退出（shutdown 时 dispose 也会主动清掉）
        if (typeof tickTimer.unref === 'function')
            tickTimer.unref();
    }
    function stopTicker() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
        // 没有管理员时丢弃基线：下一个管理员连上会立刻拿到完整列表并重建基线
        lastRoomsSignature = null;
    }
    // ---------- 连接 ----------
    namespace.on('connection', (socket) => {
        socket.data.watched = new Set();
        watcherSignatures.set(socket.id, new Map());
        // §14.2：连接成功后立即推一次房间列表
        const rooms = game.listRooms();
        socket.emit('admin:rooms', makeRoomsPayload(rooms, Date.now()));
        // 只有「首个管理员」才建立变化比对基线；已有管理员时不覆盖，避免吞掉
        // 其他管理员尚未收到的一次变化（下个 tick 会照常推送给他们）
        if (lastRoomsSignature === null)
            lastRoomsSignature = signatureOf(rooms);
        // 主动拉一次房间列表（日常靠服务端推送）
        socket.on('admin:rooms:request', (payload, ack) => {
            const args = splitAdminArgs(payload, ack);
            respond(args.ack, safeResult(() => ({
                ok: true,
                rooms: makeRoomsPayload(game.listRooms(), Date.now()),
            })));
        });
        // 开始观战：ack 立即返回一份快照，后续靠 admin:room:state 增量推送
        socket.on('admin:room:watch', (payload, ack) => {
            const args = splitAdminArgs(payload, ack);
            respond(args.ack, safeResult(() => {
                const code = normalizeCode(readCode(args.payload));
                if (!code)
                    return fail('INVALID_CODE');
                const room = game.rooms.get(code);
                if (!room)
                    return fail('ROOM_NOT_FOUND');
                const detail = game.getSpectatorState(room);
                socket.data.watched.add(code);
                // 记录已推送内容：ack 里已经给了同一份快照，下个 tick 不重复推
                watcherSignatures.get(socket.id)?.set(code, JSON.stringify(detail));
                return { ok: true, detail };
            }));
        });
        // 停止观战（幂等：没在观战也返回成功）
        socket.on('admin:room:unwatch', (payload, ack) => {
            const args = splitAdminArgs(payload, ack);
            respond(args.ack, safeResult(() => {
                const code = normalizeCode(readCode(args.payload));
                if (!code)
                    return fail('INVALID_CODE');
                socket.data.watched.delete(code);
                watcherSignatures.get(socket.id)?.delete(code);
                return { ok: true };
            }));
        });
        // 终止并删除房间（§14.3）：玩家先收到既有 room:error {code:'ROOM_DELETED'}
        socket.on('admin:room:delete', (payload, ack) => {
            const args = splitAdminArgs(payload, ack);
            let deleted = null;
            const result = safeResult(() => {
                const outcome = game.adminDeleteRoom(readCode(args.payload));
                if (!outcome.ok)
                    return outcome;
                deleted = outcome.code;
                return outcome;
            });
            // 先回 ack（§14.3 步骤 4），再通知观战方并立即刷新列表
            respond(args.ack, result);
            if (deleted) {
                closeWatchedRoom(deleted, 'deleted');
                pushRoomsIfChanged(Date.now());
            }
        });
        socket.on('disconnect', () => {
            watcherSignatures.delete(socket.id);
            socket.data.watched.clear();
            // 最后一个管理员断开：停止空转
            if (namespace.sockets.size === 0)
                stopTicker();
        });
        startTicker();
    });
    // ---------- 清理 ----------
    function dispose() {
        disposed = true;
        stopTicker();
        authFailures.clear();
        watcherSignatures.clear();
        namespace.removeAllListeners();
        // 主动断开管理员连接（shutdown 时 io.close() 也会兜底）
        try {
            namespace.disconnectSockets(true);
        }
        catch (err) {
            console.error('[同声传意][admin] 断开管理员连接失败', err);
        }
    }
    return { namespace, dispose };
}
//# sourceMappingURL=admin.js.map