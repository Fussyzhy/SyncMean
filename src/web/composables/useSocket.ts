/**
 * socket.io 客户端封装（typed socket + 事件订阅 + ack 超时 + 断线重连）。
 *
 * 旧实现通过服务端下发的 /socket.io/socket.io.js 拿到 window.io；
 * 迁移后由 Vite 打包 socket.io-client，连接仍是同源、路径不变。
 *
 * emitAck 与旧实现语义一致：
 * - 未连接 → 立即回调 OFFLINE；
 * - 10s 内没有 ack → 回调 TIMEOUT（调用方负责把 loading 归位）；
 * - ack 载荷非对象或没有 ok 字段 → BAD_ACK；
 * - emit 同步抛错 → EMIT_FAILED。
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  Ack,
  ActionResult,
  ClientToServerEvents,
  CountdownPayload,
  NoticePayload,
  PublicRoomState,
  RevealPayload,
  RoomErrorPayload,
  RoundOpenPayload,
  ServerToClientEvents,
} from '@shared/protocol';

const ACK_TIMEOUT_MS = 10000;

export type ClientFailureCode = 'OFFLINE' | 'TIMEOUT' | 'BAD_ACK' | 'EMIT_FAILED';

/** 纯客户端失败（未连接 / 超时 / 协议异常），error 不属于服务端 ErrorCode */
export interface ClientFailure {
  ok: false;
  error: ClientFailureCode;
  message: string;
}

export type AckOutcome<T> = ActionResult<T> | ClientFailure;

/** 从事件签名里抽出 ack 的结果类型 */
type AckResultOf<E extends keyof ClientToServerEvents> = NonNullable<
  Parameters<ClientToServerEvents[E]>[1]
> extends Ack<infer T>
  ? T
  : never;

/** 从事件签名里抽出请求载荷类型 */
type PayloadOf<E extends keyof ClientToServerEvents> = Parameters<ClientToServerEvents[E]>[0];

export interface SocketHandlers {
  onConnect(): void;
  onDisconnect(): void;
  onConnectError(): void;
  onState(state: PublicRoomState): void;
  onCountdown(payload: CountdownPayload): void;
  onRoundOpen(payload: RoundOpenPayload): void;
  onOpponentSubmitted(): void;
  onReveal(payload: RevealPayload): void;
  onNotice(payload: NoticePayload): void;
  onRoomError(payload: RoomErrorPayload): void;
}

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export interface SocketApi {
  ensureSocket(handlers: SocketHandlers): Socket<ServerToClientEvents, ClientToServerEvents>;
  emitAck<E extends keyof ClientToServerEvents>(
    event: E,
    payload: PayloadOf<E>,
    cb: (res: AckOutcome<AckResultOf<E>>) => void,
  ): void;
  isConnected(): boolean;
}

export function useSocket(): SocketApi {
  function ensureSocket(
    handlers: SocketHandlers,
  ): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (socket) return socket;
    // 同源连接：dev 由 vite proxy 转发 /socket.io，生产由 express 同端口托管
    socket = io({
      reconnection: true,
      reconnectionDelay: 700,
      reconnectionDelayMax: 4000,
    }) as Socket<ServerToClientEvents, ClientToServerEvents>;

    socket.on('connect', () => handlers.onConnect());
    socket.on('disconnect', () => handlers.onDisconnect());
    socket.on('connect_error', () => handlers.onConnectError());
    socket.on('room:state', (state) => handlers.onState(state));
    socket.on('round:countdown', (payload) => handlers.onCountdown(payload));
    socket.on('round:open', (payload) => handlers.onRoundOpen(payload));
    socket.on('round:opponent-submitted', () => handlers.onOpponentSubmitted());
    socket.on('round:reveal', (payload) => handlers.onReveal(payload));
    socket.on('room:notice', (payload) => handlers.onNotice(payload));
    socket.on('room:error', (payload) => handlers.onRoomError(payload));
    return socket;
  }

  function emitAck<E extends keyof ClientToServerEvents>(
    event: E,
    payload: PayloadOf<E>,
    cb: (res: AckOutcome<AckResultOf<E>>) => void,
  ): void {
    const current = socket;
    const done = (res: AckOutcome<AckResultOf<E>>): void => cb(res);
    if (!current || !current.connected) {
      done({ ok: false, error: 'OFFLINE', message: '还没连上服务器，稍等一下再试' });
      return;
    }
    let settled = false;
    const settle = (res: AckOutcome<AckResultOf<E>>): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      done(res);
    };
    const timer = window.setTimeout(() => {
      settle({ ok: false, error: 'TIMEOUT', message: '服务器没回应，稍后再试' });
    }, ACK_TIMEOUT_MS);

    try {
      // socket.emit 的泛型重载无法从「运行时 event 变量」推导，这里收敛成最小签名后调用；
      // 对外的类型安全由 emitAck 的泛型签名保证。
      const rawEmit = (current as unknown as {
        emit: (ev: string, data: unknown, ack: (res: unknown) => void) => void;
      }).emit.bind(current);
      rawEmit(event, payload, (res: unknown) => {
        if (res && typeof res === 'object' && typeof (res as { ok?: unknown }).ok === 'boolean') {
          settle(res as AckOutcome<AckResultOf<E>>);
        } else {
          settle({ ok: false, error: 'BAD_ACK', message: '服务器返回异常' });
        }
      });
    } catch {
      settle({ ok: false, error: 'EMIT_FAILED', message: '发送失败，再试一次' });
    }
  }

  function isConnected(): boolean {
    return !!socket && socket.connected;
  }

  return { ensureSocket, emitAck, isConnected };
}
