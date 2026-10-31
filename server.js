'use strict';

/**
 * 同声传意 —— Express + Socket.IO 装配层
 *
 * 只负责：HTTP 路由、静态资源、socket 事件接线。
 * 全部房间 / 对局规则在 src/game.js。
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const Game = require('./src/game');

const { ERROR_MESSAGES } = Game;

const PORT = process.env.PORT || 3210;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

const app = express();
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server(server);

/** 房间频道名（加前缀，避免与 socket id 同名房间混淆） */
function channelName(code) {
  return `room_${code}`;
}

const game = new Game({
  emitToRoom(code, event, payload) {
    io.to(channelName(code)).emit(event, payload);
  },
  emitToPlayer(player, event, payload) {
    if (player && player.socketId) io.to(player.socketId).emit(event, payload);
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
});

// ==================== HTTP ====================

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, rooms: game.roomCount() });
});

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
      .send('「同声传意」前端页面尚未就绪：public/index.html 不存在。请先完成前端或访问 /health。');
  });
});

// ==================== Socket.IO ====================

io.on('connection', (socket) => {
  /** ack 统一回复（客户端可能不传回调） */
  function respond(ack, result) {
    if (typeof ack !== 'function') return;
    try {
      ack(result);
    } catch (err) {
      console.error('[同声传意] ack 回调异常', err);
    }
  }

  /** 统一处理 {payload, ack} 形式，兜住异常，保证一定 ack {ok:false,...} */
  function handler(fn) {
    return function onEvent(payload, ack) {
      let data = payload;
      let reply = ack;
      if (typeof payload === 'function' && ack === undefined) {
        data = {};
        reply = payload;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

      let result;
      try {
        result = fn(data);
      } catch (err) {
        console.error('[同声传意] 事件处理异常', err);
        result = { ok: false, error: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL };
      }
      respond(reply, result);
    };
  }

  /**
   * 一个 socket 只能身处一个房间；在进入新房间前先退出旧房间，
   * keepCode 用于「同一房间用 token 重连」时不误删自己。
   */
  function detachOtherRooms(keepCode) {
    const current = game.roomCodeOf(socket.id);
    if (!current || current === keepCode) return;
    socket.leave(channelName(current));
    game.leaveRoom(socket.id);
  }

  socket.on(
    'room:create',
    handler((data) => {
      detachOtherRooms(null);
      const result = game.createRoom(socket.id, data);
      if (result.ok) socket.join(channelName(result.code));
      return result;
    })
  );

  socket.on(
    'room:join',
    handler((data) => {
      const keepCode = typeof data.code === 'string' ? data.code.trim().toUpperCase() : null;
      detachOtherRooms(keepCode);
      const result = game.joinRoom(socket.id, data);
      if (result.ok) socket.join(channelName(result.code));
      return result;
    })
  );

  socket.on(
    'room:leave',
    handler(() => {
      const code = game.roomCodeOf(socket.id);
      // 先离开频道，避免自己收到自己的「离开了房间」提示
      if (code) socket.leave(channelName(code));
      return game.leaveRoom(socket.id);
    })
  );

  socket.on(
    'player:ready',
    handler((data) => game.setReady(socket.id, data.ready))
  );

  socket.on(
    'round:submit',
    handler((data) => game.submitWord(socket.id, data.word))
  );

  socket.on(
    'round:agree',
    handler((data) => game.setAgree(socket.id, data.agree))
  );

  socket.on(
    'round:next',
    handler(() => game.nextRound(socket.id))
  );

  socket.on(
    'game:restart',
    handler(() => game.restart(socket.id))
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
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[同声传意] 收到 ${signal}，正在关闭……`);
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
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, io, game };
