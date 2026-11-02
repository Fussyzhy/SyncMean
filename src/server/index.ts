/**
 * 同声传意 —— Express + Socket.IO 装配层（TypeScript / ESM 版，与旧 server.js 等价）
 *
 * 只负责：HTTP 路由、静态资源、socket 事件接线。
 * 全部房间 / 对局规则在 src/server/game.ts。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import Game, { ERROR_MESSAGES } from './game.js';
import type {
  ActionError,
  ActionResult,
  AgreeOk,
  AgreePayload,
  ClientToServerEvents,
  CreateOk,
  CreatePayload,
  EmptyPayload,
  EmoteOk,
  EmotePayload,
  InterServerEvents,
  JoinOk,
  JoinPayload,
  ReadyPayload,
  RestartOk,
  ServerToClientEvents,
  SimpleOk,
  SocketData,
  SubmitOk,
  SubmitPayload,
} from '../shared/protocol.js';
import type { GameTransport } from './game.js';

const PORT = Number(process.env.PORT || 3210);

// 项目根 = 本模块往上两级（`src/server/index.ts` 与编译后 `dist/server/index.js` 都是两级），
// 前端产物固定托管在 `<root>/dist/public`。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'dist', 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

const app = express();
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
  server
);

/** 房间频道名（加前缀，避免与 socket id 同名房间混淆） */
function channelName(code: string): string {
  return `room_${code}`;
}

/**
 * socket.io 的 emit 是「事件名 ↔ 载荷」相关联的泛型重载；Game 侧已经用
 * `ServerPayload<事件名>` 校验过类型，桥接到 socket.io 的运行时契约时统一放宽。
 */
const emitCompat = (target: ReturnType<typeof io.to>) => {
  return (event: keyof ServerToClientEvents, payload: unknown): void => {
    (target.emit as unknown as (ev: string, data: unknown) => boolean)(event, payload);
  };
};

const transport: GameTransport = {
  emitToRoom(code, event, payload) {
    emitCompat(io.to(channelName(code)))(event, payload);
  },
  emitToPlayer(player, event, payload) {
    if (player && player.socketId) emitCompat(io.to(player.socketId))(event, payload);
  },
  onSocketReplaced(oldSocketId, room, player) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) oldSocket.leave(channelName(room.code));
    io.to(oldSocketId).emit('room:error', {
      code: 'REPLACED',
      message: ERROR_MESSAGES.REPLACED,
    });
    console.log(`[同声传意] ${player.name} 的连接被顶替（room=${room.code}）`);
  },
};

const game = new Game(transport);

// ==================== HTTP ====================

/**
 * v3.3：统一安全响应头。CSP 与前端现状匹配（Vue 运行时需要 'unsafe-inline'，
 * 传输层是 socket.io 的 WebSocket，故 connect-src 放行 ws:/wss:；
 * 导出图与复制图片会 `fetch(blob:)` / `fetch(data:)`，因此 connect-src 也放行 blob:/data:）。
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: blob: data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

app.use((req, res, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, rooms: game.roomCount() });
});

// 带内容哈希的构建产物：长缓存 + immutable；fallthrough:false 让缺失资源直接 404，
// 避免被后面的 SPA 回落成 index.html（否则刷新时可能把 HTML 当成 JS/CSS 返回）。
app.use(
  '/assets',
  express.static(path.join(PUBLIC_DIR, 'assets'), {
    immutable: true,
    maxAge: '1y',
    fallthrough: false,
  })
);

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

// SPA 回落：/ 与 /?room=ABCD 都返回 index.html（前端尚未提供时给出明确 404 而不是崩溃）
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.sendFile(INDEX_FILE, (err) => {
    if (!err) return;
    if (res.headersSent) return;
    res
      .status(404)
      .type('text/plain; charset=utf-8')
      .send('「同声传意」前端页面尚未就绪：dist/public/index.html 不存在。请先完成前端或访问 /health。');
  });
});

// ==================== Socket.IO ====================

/** ack 统一回复（客户端可能不传回调；事件间结果类型不同，这里只做运行时兜底） */
function respond(ack: unknown, result: unknown): void {
  if (typeof ack !== 'function') return;
  try {
    (ack as (value: unknown) => void)(result);
  } catch (err) {
    console.error('[同声传意] ack 回调异常', err);
  }
}

/** 统一处理 {payload, ack} 形式，兜住异常，保证一定 ack {ok:false,...} */
function handler<TPayload, TResult>(fn: (data: TPayload) => TResult) {
  return function onEvent(
    payload: TPayload | ((result: TResult) => void) | undefined,
    ack?: (result: TResult) => void
  ): void {
    let data: unknown = payload;
    let reply: ((result: TResult) => void) | undefined = ack;
    if (typeof payload === 'function' && ack === undefined) {
      data = {};
      reply = payload as unknown as (result: TResult) => void;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

    let result: TResult | ActionError;
    try {
      result = fn(data as TPayload);
    } catch (err) {
      console.error('[同声传意] 事件处理异常', err);
      result = { ok: false, error: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL };
    }
    respond(reply, result);
  };
}

io.on('connection', (socket) => {
  /**
   * 一个 socket 只能身处一个房间；在进入新房间前先退出旧房间，
   * keepCode 用于「同一房间用 token 重连」时不误删自己。
   */
  function detachOtherRooms(keepCode: string | null): void {
    const current = game.roomCodeOf(socket.id);
    if (!current || current === keepCode) return;
    socket.leave(channelName(current));
    game.leaveRoom(socket.id);
  }

  socket.on(
    'room:create',
    handler<CreatePayload, ActionResult<CreateOk>>((data) => {
      detachOtherRooms(null);
      const result = game.createRoom(socket.id, data);
      if (result.ok) socket.join(channelName(result.code));
      return result;
    })
  );

  socket.on(
    'room:join',
    handler<JoinPayload, ActionResult<JoinOk>>((data) => {
      const keepCode = typeof data.code === 'string' ? data.code.trim().toUpperCase() : null;
      detachOtherRooms(keepCode);
      const result = game.joinRoom(socket.id, data);
      if (result.ok) socket.join(channelName(result.code));
      return result;
    })
  );

  socket.on(
    'room:leave',
    handler<EmptyPayload, ActionResult<SimpleOk>>(() => {
      const code = game.roomCodeOf(socket.id);
      // 先离开频道，避免自己收到自己的「离开了房间」提示
      if (code) socket.leave(channelName(code));
      return game.leaveRoom(socket.id);
    })
  );

  socket.on(
    'player:ready',
    handler<ReadyPayload, ActionResult<SimpleOk>>((data) => game.setReady(socket.id, data.ready))
  );

  socket.on(
    'round:submit',
    handler<SubmitPayload, ActionResult<SubmitOk>>((data) =>
      game.submitWord(socket.id, data.word)
    )
  );

  socket.on(
    'room:emote',
    handler<EmotePayload, ActionResult<EmoteOk>>((data) => game.emote(socket.id, data.kind))
  );

  socket.on(
    'round:agree',
    handler<AgreePayload, ActionResult<AgreeOk>>((data) => game.setAgree(socket.id, data.agree))
  );

  socket.on(
    'round:next',
    handler<EmptyPayload, ActionResult<SimpleOk>>(() => game.nextRound(socket.id))
  );

  socket.on(
    'game:restart',
    handler<EmptyPayload, ActionResult<RestartOk>>(() => game.restart(socket.id))
  );

  socket.on(
    'game:end',
    handler<EmptyPayload, ActionResult<SimpleOk>>(() => game.endGame(socket.id))
  );

  socket.on('disconnect', () => {
    game.disconnect(socket.id);
  });
});

// ==================== 启动 / 关闭 ====================

game.startSweeper();

server.listen(PORT, () => {
  console.log(`[同声传意] 服务已启动：http://localhost:${PORT}`);
  console.log(`[同声传意] 健康检查：http://localhost:${PORT}/health`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[同声传意] 收到 ${signal}，正在关闭……`);
  // v3.3：先给所有房间发关停通知，留 250ms 让 socket.io 把消息刷出去，再清理房间
  try {
    game.announceShutdown();
  } catch (err) {
    console.error('[同声传意] 广播关停通知失败', err);
  }
  setTimeout(() => {
    try {
      game.shutdown();
    } catch (err) {
      console.error('[同声传意] 清理房间失败', err);
    }
    try {
      io.close(() => process.exit(0));
    } catch (err) {
      console.error('[同声传意] 关闭 Socket.IO 失败', err);
    }
  }, 250);
  // 兜底：无论上面哪一步卡住，2s 后强制退出
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server, io, game };
