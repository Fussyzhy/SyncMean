/**
 * 同声传意 —— 端到端自测（tools/sim.ts）
 *
 * 自包含：以子进程启动 src/server/index.ts（tsx；PORT 默认 3299，可用 SIM_PORT 覆盖），
 * 等 /health 就绪后用两个 socket.io-client 假玩家跑完整流程并断言，
 * 结束后杀掉子进程；退出码 0 = 全过，1 = 有断言失败。
 *
 * 运行：yarn test
 */

import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io, type Socket } from 'socket.io-client';

import GameModule, { constants, normalize, type Player, type Room } from '../src/server/game.js';
import type {
  ActionError,
  ActionResult,
  AgreeOk,
  AgreePayload,
  ClientToServerEvents,
  CreateOk,
  CreatePayload,
  EmptyPayload,
  HistoryItem,
  JoinOk,
  JoinPayload,
  NoticePayload,
  PublicRoomState,
  ReadyPayload,
  RestartOk,
  RevealPayload,
  RoomErrorPayload,
  RoundOpenPayload,
  Seat,
  ServerToClientEvents,
  SimpleOk,
  SubmitOk,
  SubmitPayload,
} from '../src/shared/protocol.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 3299;
let PORT = Number(process.env.SIM_PORT || DEFAULT_PORT);
const baseUrl = (): string => `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 20000;
const ACK_TIMEOUT_MS = 8000;

let checkCount = 0;
let child: ManagedChild | null = null;
const clients: TestClient[] = [];

/* ==================== 类型基础设施 ==================== */

/** 某个「服务端 → 客户端」事件对应的载荷类型 */
type ServerPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

type ManagedChild = ChildProcess & { __logs?: ServerLogs };

interface ServerLogs {
  out: string;
  err: string;
}

interface HealthBody {
  ok: boolean;
  rooms: number;
}

interface HttpResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

interface StartedServer {
  proc: ChildProcess;
  logs: ServerLogs;
  health: HealthBody;
}

interface LogEntry {
  event: string;
  payload: unknown;
  at: number;
}

interface TestClient {
  label: string;
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  log: LogEntry[];
  mark(): number;
  disconnect(): void;
}

/** 客户端 → 服务端事件的请求载荷类型（供 emitAck 收窄） */
interface ClientPayloads {
  'room:create': CreatePayload;
  'room:join': JoinPayload;
  'room:leave': EmptyPayload;
  'player:ready': ReadyPayload;
  'round:submit': SubmitPayload;
  'round:agree': AgreePayload;
  'round:next': EmptyPayload;
  'game:restart': EmptyPayload;
}

/** 客户端 → 服务端事件的 ack 结果类型（供断言收窄） */
interface AckResults {
  'room:create': ActionResult<CreateOk>;
  'room:join': ActionResult<JoinOk>;
  'room:leave': ActionResult<SimpleOk>;
  'player:ready': ActionResult<SimpleOk>;
  'round:submit': ActionResult<SubmitOk>;
  'round:agree': ActionResult<AgreeOk>;
  'round:next': ActionResult<SimpleOk>;
  'game:restart': ActionResult<RestartOk>;
}

interface WaitEventOptions {
  since?: number;
  timeout?: number;
  hint?: string;
}

/* ==================== 断言 / 日志 ==================== */

function step(name: string): void {
  console.log(`\n▶ ${name}`);
}

function pass(name: string): void {
  console.log(`  ✓ ${name}`);
}

function ok(condition: unknown, message: string): asserts condition {
  checkCount += 1;
  if (!condition) throw new Error(`断言失败：${message}`);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  checkCount += 1;
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    throw new Error(
      `断言失败：${message}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`
    );
  }
}

/** 断言 ack 成功（保留原有「成功才继续读字段」的强度） */
function asOk<T extends { ok: true }>(result: ActionResult<T>): T {
  const maybe = result as { ok?: boolean };
  if (maybe.ok === true) return result as T;
  throw new Error(`断言失败：期望成功结果，实际 ${JSON.stringify(result)}`);
}

/** 断言 ack 失败，返回 ActionError */
function asError<T>(result: ActionResult<T>): ActionError {
  const maybe = result as { ok?: boolean };
  if (maybe.ok === true) throw new Error(`断言失败：期望失败结果，实际 ${JSON.stringify(result)}`);
  return result as ActionError;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 记录下来的事件条目 → 具体载荷（只在按事件名过滤后使用，运行期与旧版一致） */
function stateOf(entry: { payload: unknown }): PublicRoomState {
  return entry.payload as PublicRoomState;
}

function noticeOf(entry: { payload: unknown }): NoticePayload {
  return entry.payload as NoticePayload;
}

function errorOf(entry: { payload: unknown }): RoomErrorPayload {
  return entry.payload as RoomErrorPayload;
}

/* ==================== HTTP ==================== */

function request(urlPath: string, timeout = 3000): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl()}${urlPath}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`GET ${urlPath} 超时`)));
    req.on('error', reject);
  });
}

async function fetchJson(urlPath: string): Promise<{ status: number; body: HealthBody }> {
  const res = await request(urlPath);
  return { status: res.status, body: JSON.parse(res.body) as HealthBody };
}

/* ==================== 子进程服务 ==================== */

async function startServer(): Promise<StartedServer> {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'src/server/index.ts')],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  ) as ManagedChild;
  child = proc;

  const logs: ServerLogs = { out: '', err: '' };
  let readyLogged = false;
  proc.stdout?.on('data', (chunk: Buffer) => {
    logs.out += chunk.toString();
    if (logs.out.includes('[同声传意] 服务已启动')) readyLogged = true;
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    logs.err += chunk.toString();
  });
  proc.__logs = logs;

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `服务器提前退出（code=${proc.exitCode}）\nstdout:\n${logs.out}\nstderr:\n${logs.err}`
      );
    }
    // 必须等到“自己的子进程”打印监听成功，避免误连上占着同一端口的其它服务
    if (!readyLogged) {
      await sleep(50);
      continue;
    }
    try {
      const res = await request('/health', 1000);
      if (res.status === 200) {
        const body = JSON.parse(res.body) as HealthBody;
        if (body.ok === true) return { proc, logs, health: body };
      }
    } catch {
      // 尚未就绪，继续轮询
    }
    await sleep(100);
  }
  throw new Error(
    `服务器 ${START_TIMEOUT_MS}ms 内未就绪\nstdout:\n${logs.out}\nstderr:\n${logs.err}`
  );
}

async function stopServer(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const current = child;
  const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
  try {
    current.kill('SIGKILL');
  } catch {
    // ignore
  }
  await Promise.race([exited, sleep(3000)]);
}

/** 子进程日志（供失败时打印；用函数包一层，避免跨闭包的控制流收窄误判） */
function childLogs(): ServerLogs | undefined {
  return child ? child.__logs : undefined;
}

/** 申请一个系统分配的空闲端口（用于 3299 被占用时的兜底） */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** 默认用 3299；若端口被别的进程占用，自动换一个空闲端口重试 */
async function startServerWithRetry(): Promise<StartedServer> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await startServer();
    } catch (err) {
      failures.push(err instanceof Error && err.message ? err.message : String(err));
      // 启动失败（最常见是端口被占）——换一个系统分配的空闲端口重试
      await stopServer();
      PORT = await findFreePort();
      console.log(`  启动失败，自动换到 ${PORT} 重试`);
    }
  }
  throw new Error(`连续 3 次启动失败：\n${failures.join('\n---\n')}`);
}

/* ==================== socket 客户端封装 ==================== */

async function connectClient(label: string): Promise<TestClient> {
  const socket = io(baseUrl(), {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 8000,
  }) as Socket<ServerToClientEvents, ClientToServerEvents>;

  const client: TestClient = {
    label,
    socket,
    log: [],
    mark() {
      return this.log.length;
    },
    disconnect() {
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
    },
  };
  clients.push(client);

  // 记录收到的所有服务端事件（onAny 只包含事件，不含 ack）
  socket.onAny((event: string, ...args: unknown[]) => {
    const payload: unknown = args.length <= 1 ? args[0] : args;
    client.log.push({
      event,
      payload,
      at: Date.now(),
    });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 连接超时`)), 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label} 连接失败：${err.message}`));
    });
  });

  return client;
}

function emitAck<E extends keyof ClientToServerEvents>(
  client: TestClient,
  event: E,
  payload: ClientPayloads[E],
  timeout = ACK_TIMEOUT_MS
): Promise<AckResults[E]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${client.label} 的 ${event} 在 ${timeout}ms 内没有收到 ack`));
    }, timeout);

    (client.socket.emit as unknown as (
      ev: string,
      data: unknown,
      ack: (res: unknown) => void
    ) => boolean)(event, payload, (res: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res as AckResults[E]);
    });
  });
}

/**
 * 在 client.log[since..] 中等待一个满足 predicate 的 event。
 * since 用 client.mark() 在触发动作前抓取，避免旧事件误命中。
 */
async function waitEvent<E extends keyof ServerToClientEvents>(
  client: TestClient,
  event: E,
  predicate: (payload: ServerPayload<E>) => boolean = () => true,
  options: WaitEventOptions = {}
): Promise<ServerPayload<E>> {
  const { since = 0, timeout = 12000, hint } = options;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (let i = since; i < client.log.length; i += 1) {
      const entry = client.log[i];
      if (entry.event === event && predicate(entry.payload as ServerPayload<E>)) {
        return entry.payload as ServerPayload<E>;
      }
    }
    await sleep(20);
  }
  const seen = client.log
    .slice(since)
    .map((entry) => entry.event)
    .join(', ');
  throw new Error(
    `${client.label} 在 ${timeout}ms 内未等到 ${event}${hint ? `（${hint}）` : ''}；期间收到: [${seen}]`
  );
}

function isEmptyPayload(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 0
  );
}

function payloadMentions(payload: unknown, needle: string): boolean {
  if (payload === undefined) return false;
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return false;
  }
  return typeof json === 'string' && json.includes(needle);
}

function hasOwn(obj: unknown, key: string): boolean {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

/* ==================== 主流程 ==================== */

async function main(): Promise<void> {
  // ---------- 0. 纯函数 / 常量 ----------
  step('0. 判定归一化与时间常量');
  eq(normalize('Ａｐｐｌｅ! '), 'apple', 'NFKC + 小写 + 去标点空白');
  eq(normalize('  词 穷！'), '词穷', '中文标点与空格不参与判定');
  eq(normalize('   '), '', '纯空白归一化为空串');
  ok(normalize('Ａpple') === normalize('apple'), '全角半角不影响判定');
  ok(constants.COUNTDOWN_MS === 3000, 'COUNTDOWN_MS = 3000');
  ok(constants.DEFAULT_SUBMIT_MS === 60000, 'DEFAULT_SUBMIT_MS = 60000');
  eq(constants.SUBMIT_LIMIT_OPTIONS, [0, 60000, 180000, 300000], 'SUBMIT_LIMIT_OPTIONS 仅 0/1/3/5 分钟');
  ok(!hasOwn(constants, 'SUBMIT_MS'), 'constants 不再导出 SUBMIT_MS');
  ok(!hasOwn(constants, 'REVEAL_MS'), 'constants 不再导出 REVEAL_MS');
  ok(constants.START_DELAY === 300, 'START_DELAY = 300');
  ok(constants.CODE_RE.test('AB23'), '房间码格式 A-Z2-9 四位');
  ok(!constants.CODE_RE.test('AB12'), '房间码不含易混淆的 1/0/I/O');
  ok(!constants.CODE_ALPHABET.includes('O'), '字符集不含 O');
  ok(!constants.CODE_ALPHABET.includes('I'), '字符集不含 I');
  ok(!constants.CODE_ALPHABET.includes('0'), '字符集不含 0');
  ok(!constants.CODE_ALPHABET.includes('1'), '字符集不含 1');
  pass('normalize / 常量');

  // ---------- 1. 启动服务 ----------
  step('1. 启动服务并检查 /health');
  const started = await startServerWithRetry();
  console.log(`  子进程 PID=${started.proc.pid}，PORT=${PORT}`);
  console.log(
    '  端口口径说明：`yarn start` 用编译产物 dist/server/index.js 的 PORT || 3210（PROTOCOL.md §2）；' +
      '本测试自起临时服务用 SIM_PORT || 3299（避让 3210，README「不占用 3210」即指此），两者不同属有意为之，文档未改。'
  );
  const health0 = await fetchJson('/health');
  eq(health0.status, 200, 'GET /health 返回 200');
  eq(health0.body, { ok: true, rooms: 0 }, '/health 返回 {ok:true, rooms:0}');

  const sioJs = await request('/socket.io/socket.io.js');
  eq(sioJs.status, 200, '前端可从 /socket.io/socket.io.js 加载客户端');
  ok(sioJs.body.includes('socket.io'), 'socket.io 客户端脚本内容正常');
  pass('/health + socket.io 客户端');

  // ---------- 2. 输入校验 ----------
  step('2. 输入校验');
  const D = await connectClient('D');
  const badName = asError(await emitAck(D, 'room:create', { name: '' }));
  eq(
    { ok: badName.ok, error: badName.error },
    { ok: false, error: 'INVALID_NAME' },
    '空昵称 -> INVALID_NAME'
  );
  eq(Object.keys(badName).sort(), ['error', 'message', 'ok'], '错误返回仅 {ok,error,message}');
  ok(typeof badName.message === 'string' && badName.message.length > 0, '错误 message 为中文提示');
  const longName = asError(await emitAck(D, 'room:create', { name: '一二三四五六七八九十一二三' }));
  eq(longName.error, 'INVALID_NAME', '超 12 字昵称 -> INVALID_NAME');
  const badCode = asError(await emitAck(D, 'room:join', { code: 'bad', name: '甲' }));
  eq(badCode.error, 'INVALID_CODE', '非法房间码 -> INVALID_CODE');
  const noRoom = asError(await emitAck(D, 'room:join', { code: 'ZZZZ', name: '甲' }));
  eq(noRoom.error, 'ROOM_NOT_FOUND', '不存在的房间 -> ROOM_NOT_FOUND');
  const noRoomSubmit = asError(await emitAck(D, 'round:submit', { word: '苹果' }));
  eq(noRoomSubmit.error, 'NOT_IN_ROOM', '不在房间提交 -> NOT_IN_ROOM');
  pass('昵称/房间码/未入房 校验');

  // ---------- 3. 建房 / 加入 / 第三人与视角 ----------
  step('3. 建房、加入、第三人被拒、按视角生成 room:state');
  const A = await connectClient('A');
  const markCreate = A.mark();
  const createRes = asOk(await emitAck(A, 'room:create', { name: '小明', token: 'client-token-a' }));
  eq(Object.keys(createRes).sort(), ['code', 'ok', 'seat', 'token'], 'room:create ack 字段');
  eq(createRes.ok, true, '建房成功');
  eq(createRes.seat, 'a', '建房者 seat = a');
  ok(/^[A-Z2-9]{4}$/.test(createRes.code), `房间码格式正确（${createRes.code}）`);
  ok(typeof createRes.token === 'string' && createRes.token.length > 0, '返回 token');
  eq(createRes.token, 'client-token-a', '建房时沿用客户端 token（前端刷新后可恢复）');
  const code = createRes.code;
  const tokenA = createRes.token;

  const health1 = await fetchJson('/health');
  eq(health1.body.rooms, 1, '建房后 /health rooms = 1');

  const stateA1 = await waitEvent(
    A,
    'room:state',
    (s) => s.code === code && s.players.length === 1,
    { since: markCreate, timeout: 3000, hint: '建房后的初始 state' }
  );
  eq(
    Object.keys(stateA1).sort(),
    [
      'agree',
      'basis',
      'code',
      'deadline',
      'history',
      'phase',
      'players',
      'result',
      'round',
      'settlePending',
      'submitLimitMs',
      'submitted',
      'you',
    ],
    'PublicRoomState 字段与协议一致'
  );
  eq(stateA1.phase, 'lobby', '初始 phase = lobby');
  eq(stateA1.settlePending, false, '§10.10 新房 settlePending=false（准备页绝不能被结算锁定误伤）');
  eq(stateA1.round, 1, '初始 round = 1');
  eq(stateA1.basis, null, '首轮 basis = null');
  eq(stateA1.agree, { you: false, opponent: false }, 'lobby 阶段 agree 恒为 false');
  eq(stateA1.submitLimitMs, 60000, '默认建房（不传 submitLimitMs）-> submitLimitMs=60000（1 分钟）');
  eq(stateA1.you, { seat: 'a', name: '小明', isHost: true }, 'you 视角');
  eq(
    stateA1.players,
    [
      {
        seat: 'a',
        name: '小明',
        isHost: true,
        ready: false,
        connected: true,
        isYou: true,
        settleDismissed: false,
      },
    ],
    'players 初始状态'
  );
  eq(stateA1.submitted, { you: false, opponent: false }, 'submitted 初始为 false');
  eq(stateA1.deadline, null, 'lobby deadline = null');
  eq(stateA1.result, null, 'lobby result = null');
  eq(stateA1.history, [], 'lobby history = []');

  const B = await connectClient('B');
  const markAJoin = A.mark();
  const markBJoin = B.mark();
  const joinRes = asOk(
    await emitAck(B, 'room:join', { code, name: '小红', token: 'client-token-b' })
  );
  eq(Object.keys(joinRes).sort(), ['code', 'ok', 'seat', 'state', 'token'], 'room:join ack 字段');
  eq(joinRes.ok, true, '第二人加入成功');
  eq(joinRes.code, code, '返回相同房间码');
  eq(joinRes.seat, 'b', '第二人 seat = b');
  ok(joinRes.token !== tokenA, '第二人 token 不同');
  ok(joinRes.token !== 'client-token-b', '新加入者由服务端生成 token（不复用设备 token）');
  const tokenB = joinRes.token;

  const stateB = await waitEvent(
    B,
    'room:state',
    (s) => s.players.length === 2 && s.players.some((p) => p.seat === 'b' && p.isYou),
    { since: markBJoin, timeout: 3000, hint: 'B 加入后的视角' }
  );
  eq(stateB.you, { seat: 'b', name: '小红', isHost: false }, 'B 的 you 视角');
  eq(
    stateB.players,
    [
      {
        seat: 'a',
        name: '小明',
        isHost: true,
        ready: false,
        connected: true,
        isYou: false,
        settleDismissed: false,
      },
      {
        seat: 'b',
        name: '小红',
        isHost: false,
        ready: false,
        connected: true,
        isYou: true,
        settleDismissed: false,
      },
    ],
    'B 看到的 players 含 isYou 标记'
  );
  eq(stateB.submitted, { you: false, opponent: false }, 'B 的 submitted 初始值');

  const stateA2 = await waitEvent(A, 'room:state', (s) => s.players.length === 2, {
    since: markAJoin,
    timeout: 3000,
    hint: 'A 看到第二人加入',
  });
  eq(stateA2.you.seat, 'a', 'A 的视角仍是 a');
  eq(
    stateA2.players.map((p) => p.isYou),
    [true, false],
    'A 的 players isYou 标记'
  );
  ok(joinRes.state, 'join ack 携带 state');

  const C = await connectClient('C');
  const markC = C.mark();
  const fullRes = asError(await emitAck(C, 'room:join', { code, name: '第三人' }));
  eq({ ok: fullRes.ok, error: fullRes.error }, { ok: false, error: 'ROOM_FULL' }, '第三人 -> ROOM_FULL');
  eq(Object.keys(fullRes).sort(), ['error', 'message', 'ok'], 'ROOM_FULL 错误返回字段');
  await sleep(250);
  eq(
    C.log.slice(markC).filter((entry) => entry.event === 'room:state').length,
    0,
    '被拒的第三人收不到房间广播'
  );
  pass('建房/加入/第三人被拒/视角 state');

  // ---------- 4. 双方 ready -> countdown -> open ----------
  step('4. 双方 ready -> round:countdown -> round:open');
  const markReadyA = A.mark();
  const markReadyB = B.mark();
  const readyA = await emitAck(A, 'player:ready', { ready: true });
  eq(readyA, { ok: true }, 'A ready 成功');
  const readyB = await emitAck(B, 'player:ready', { ready: true });
  eq(readyB, { ok: true }, 'B ready 成功');

  const countdownA = await waitEvent(A, 'round:countdown', (p) => Boolean(p) && p.round === 1, {
    since: markReadyA,
    timeout: 5000,
    hint: '双方 ready 后进入倒计时',
  });
  eq(countdownA, { round: 1, basis: null, seconds: 3 }, 'round:countdown 载荷');
  const countdownB = await waitEvent(B, 'round:countdown', (p) => Boolean(p) && p.round === 1, {
    since: markReadyB,
    timeout: 5000,
  });
  eq(countdownB, countdownA, '双方收到相同的 round:countdown');

  const stateCountdown = await waitEvent(A, 'room:state', (s) => s.phase === 'countdown', {
    since: markReadyA,
    timeout: 3000,
  });
  ok(
    typeof stateCountdown.deadline === 'number' && stateCountdown.deadline > Date.now(),
    'countdown 的 deadline 指向未来'
  );
  ok(
    typeof stateCountdown.deadline === 'number' && stateCountdown.deadline - Date.now() <= 3000,
    'countdown deadline 约 3 秒内'
  );

  const markOpenA = A.mark();
  const markOpenB = B.mark();
  const openA = await waitEvent(A, 'round:open', (p) => Boolean(p) && p.round === 1, {
    since: markOpenA,
    timeout: 6000,
    hint: '3 秒倒计时结束',
  });
  const openB = await waitEvent(B, 'round:open', (p) => Boolean(p) && p.round === 1, {
    since: markOpenB,
    timeout: 6000,
  });
  eq(openA, openB, '双方收到相同的 round:open');
  eq(openA.basis, null, '第一轮 basis = null');
  ok(typeof openA.deadline === 'number', 'round:open 带 deadline');
  const openDelta = openA.deadline - Date.now();
  ok(openDelta > 55000 && openDelta <= 61000, `deadline ≈ now + 60000（实际 ${openDelta}ms）`);

  const stateSubmitting = await waitEvent(A, 'room:state', (s) => s.phase === 'submitting', {
    since: markOpenA,
    timeout: 3000,
  });
  eq(stateSubmitting.submitted, { you: false, opponent: false }, '输入开放时双方均未提交');
  eq(stateSubmitting.agree, { you: false, opponent: false }, 'submitting 阶段 agree 恒 false');
  eq(stateSubmitting.submitLimitMs, 60000, '默认房间 submitting 阶段 submitLimitMs 仍为 60000');
  ok(typeof stateSubmitting.deadline === 'number', '默认房间 submitting 阶段 deadline 为数字');
  pass('倒计时与 open 事件');

  // ---------- 5. 输入校验 + 双盲提交 ----------
  step('5. 双盲提交：A 提交后 B 侧拿不到任何词');
  const badWordEmpty = asError(await emitAck(A, 'round:submit', { word: '   ' }));
  eq(badWordEmpty.error, 'INVALID_WORD', '空词 -> INVALID_WORD');
  const badWordLong = asError(
    await emitAck(A, 'round:submit', { word: '一二三四五六七八九十一二三' })
  );
  eq(badWordLong.error, 'INVALID_WORD', '超 12 字 -> INVALID_WORD');
  const stillOpen = await waitEvent(A, 'room:state', (s) => s.phase === 'submitting', {
    since: markOpenA,
    timeout: 2000,
  });
  eq(stillOpen.submitted.you, false, '非法词不会占用提交位');

  const wordA = '苹果';
  const markBLeak = B.mark();
  const markASubmit = A.mark();
  const submitA = await emitAck(A, 'round:submit', { word: wordA });
  eq(submitA, { ok: true, submitted: true }, 'room:submit ack 仅 {ok, submitted}');
  eq(Object.keys(submitA).sort(), ['ok', 'submitted'], 'submit ack 不含任何词字段');

  const opponentNotice = await waitEvent(B, 'round:opponent-submitted', () => true, {
    since: markBLeak,
    timeout: 3000,
    hint: 'A 提交后 B 收到提示',
  });
  ok(isEmptyPayload(opponentNotice), 'round:opponent-submitted 是空载荷');
  ok(!hasOwn(opponentNotice, 'word'), '提示事件不含 word 字段');

  const stateBWaiting = await waitEvent(
    B,
    'room:state',
    (s) => s.phase === 'submitting' && s.submitted.opponent === true,
    { since: markBLeak, timeout: 3000, hint: 'B 看到对方已提交' }
  );
  eq(stateBWaiting.submitted, { you: false, opponent: true }, 'B 的 submitted 只给布尔');
  eq(
    Object.keys(stateBWaiting.submitted).sort(),
    ['opponent', 'you'],
    'submitted 仅 you/opponent'
  );
  ok(!hasOwn(stateBWaiting, 'words') && !hasOwn(stateBWaiting, 'word'), 'room:state 不含词字段');

  const stateAWaiting = await waitEvent(
    A,
    'room:state',
    (s) => s.phase === 'submitting' && s.submitted.you === true,
    { since: markASubmit, timeout: 3000 }
  );
  eq(stateAWaiting.submitted, { you: true, opponent: false }, 'A 自己已提交、对方未提交');

  // B 在提交前收到的任何载荷都不得包含 A 的词
  await sleep(200);
  const leakWindow = B.log.slice(markBLeak);
  const leakEvents = leakWindow.filter((entry) => payloadMentions(entry.payload, wordA));
  eq(
    leakEvents.map((entry) => entry.event),
    [],
    `B 在提交前收到包含 A 词的载荷: [${leakEvents.map((entry) => entry.event).join(', ')}]`
  );
  pass('双盲：A 词未泄露给 B');

  // ---------- 6. 首轮揭晓：不同 -> reveal -> 手动下一轮 ----------
  step('6. 首轮揭晓「不同」，reveal 永不自动推进，只能由 round:next 手动继续');
  const wordB = '云朵';
  const markRevealA = A.mark();
  const markRevealB = B.mark();
  const submitB = await emitAck(B, 'round:submit', { word: wordB });
  eq(submitB, { ok: true, submitted: true }, 'B 提交成功');

  const revealA = await waitEvent(A, 'round:reveal', (p) => Boolean(p) && p.round === 1, {
    since: markRevealA,
    timeout: 5000,
    hint: '双方提交后同时揭晓',
  });
  const revealB = await waitEvent(B, 'round:reveal', (p) => Boolean(p) && p.round === 1, {
    since: markRevealB,
    timeout: 5000,
  });
  eq(revealA, revealB, '双方收到的 round:reveal 完全一致');
  eq(
    Object.keys(revealA).sort(),
    ['agree', 'basis', 'history', 'isWin', 'round', 'timedOut', 'winBy', 'words'],
    'round:reveal 字段'
  );
  eq(revealA.words, { a: wordA, b: wordB }, '揭晓两个词');
  eq(revealA.isWin, false, '不同 -> isWin=false');
  eq(revealA.basis, null, '首轮 reveal 的 basis=null');
  eq(revealA.timedOut, { a: false, b: false }, '均未超时');
  eq(revealA.agree, { a: false, b: false }, 'round:reveal 的 agree 此刻恒为全 false');
  eq(revealA.winBy, null, '未通关时 round:reveal 的 winBy=null');
  eq(
    revealA.history,
    [
      {
        round: 1,
        basis: null,
        words: { a: wordA, b: wordB },
        isWin: false,
        agree: { a: false, b: false },
        winBy: null,
      },
    ],
    'history 记录首轮'
  );

  const stateReveal = await waitEvent(A, 'room:state', (s) => s.phase === 'reveal', {
    since: markRevealA,
    timeout: 3000,
  });
  eq(
    stateReveal.result,
    {
      round: 1,
      words: { a: wordA, b: wordB },
      isWin: false,
      timedOut: { a: false, b: false },
      agree: { a: false, b: false },
      winBy: null,
    },
    'reveal 阶段 result'
  );
  eq(stateReveal.agree, { you: false, opponent: false }, 'reveal 初始 agree 全 false');
  eq(stateReveal.deadline, null, 'reveal 的 deadline=null（揭晓不再有任何自动推进计时器）');

  // v3：reveal 永不自动推进 —— 等待一段真实时间仍停在 reveal
  await sleep(1500);
  eq(
    A.log
      .slice(markRevealA)
      .filter((entry) => entry.event === 'round:countdown' || entry.event === 'round:open')
      .map((entry) => entry.event),
    [],
    '等待 1500ms 后仍未收到 round:countdown / round:open（reveal 不会自动推进）'
  );
  const stillRevealStates = A.log
    .slice(markRevealA)
    .filter((entry) => entry.event === 'room:state')
    .map((entry) => stateOf(entry));
  const lastStillReveal = stillRevealStates[stillRevealStates.length - 1];
  eq(lastStillReveal.phase, 'reveal', '等待真实时间后 phase 仍为 reveal');
  eq(lastStillReveal.deadline, null, '等待真实时间后 deadline 仍为 null');

  const markNextA = A.mark();
  const markNextB = B.mark();
  eq(await emitAck(A, 'round:next', {}), { ok: true }, 'reveal 只能由 round:next 手动进入下一轮');
  const countdown2A = await waitEvent(A, 'round:countdown', (p) => Boolean(p) && p.round === 2, {
    since: markNextA,
    timeout: 5000,
    hint: 'round:next 后立即进入下一轮',
  });
  const countdown2B = await waitEvent(B, 'round:countdown', (p) => Boolean(p) && p.round === 2, {
    since: markNextB,
    timeout: 8000,
  });
  eq(countdown2A, { round: 2, basis: { a: wordA, b: wordB }, seconds: 3 }, '第二轮 basis 为上轮两词');
  eq(countdown2B, countdown2A, '双方收到相同的第二轮倒计时');

  const stateCountdown2 = await waitEvent(
    A,
    'room:state',
    (s) => s.round === 2 && s.phase === 'countdown',
    { since: markNextA, timeout: 3000 }
  );
  eq(stateCountdown2.basis, { a: wordA, b: wordB }, '第二轮 state.basis');
  eq(stateCountdown2.result, null, '新一轮 result 清空');
  eq(stateCountdown2.history.length, 1, 'history 保留第一轮');
  eq(stateCountdown2.agree, { you: false, opponent: false }, '进入新一轮后 agree 清零');
  eq(stateCountdown2.submitLimitMs, 60000, '进入新一轮后 submitLimitMs 保持房间值 60000');
  pass('首轮判定不同 + 手动进入第二轮');

  const open2A = await waitEvent(A, 'round:open', (p) => Boolean(p) && p.round === 2, {
    since: markNextA,
    timeout: 6000,
  });
  eq(open2A.basis, { a: wordA, b: wordB }, '第二轮 round:open 的 basis');

  // ---------- 7. 第二轮提交相同词 -> won ----------
  step('7. 第二轮提交相同词 -> isWin=true / phase=won');
  const winWord = '太阳';
  const markWinA = A.mark();
  const markWinB = B.mark();
  eq((await emitAck(A, 'round:submit', { word: winWord })).ok, true, 'A 第二轮提交');
  await waitEvent(B, 'round:opponent-submitted', () => true, {
    since: markWinB,
    timeout: 3000,
  });
  // 第二轮同样不能泄露 A 的词给尚未提交的 B
  eq(
    B.log
      .slice(markWinB)
      .filter((entry) => payloadMentions(entry.payload, winWord))
      .map((entry) => entry.event),
    [],
    '第二轮 A 词未泄露给 B'
  );
  eq((await emitAck(B, 'round:submit', { word: winWord })).ok, true, 'B 第二轮提交');

  const winReveal = await waitEvent(A, 'round:reveal', (p) => Boolean(p) && p.round === 2, {
    since: markWinA,
    timeout: 5000,
  });
  eq(winReveal.isWin, true, '相同词 -> isWin=true');
  eq(winReveal.winBy, 'same', '归一化相同 -> winBy=same');
  eq(winReveal.agree, { a: false, b: false }, '一模一样通关不涉及同意词票');
  eq(winReveal.words, { a: winWord, b: winWord }, '第二轮两个词相同');
  eq(winReveal.basis, { a: wordA, b: wordB }, '第二轮 basis 仍是上一轮两词');
  eq(winReveal.history.length, 2, 'history 累计两轮');
  eq(
    winReveal.history[1],
    {
      round: 2,
      basis: { a: wordA, b: wordB },
      words: { a: winWord, b: winWord },
      isWin: true,
      agree: { a: false, b: false },
      winBy: 'same',
    },
    'history 第二轮记录'
  );

  const stateWon = await waitEvent(B, 'room:state', (s) => s.phase === 'won', {
    since: markWinB,
    timeout: 3000,
  });
  eq(
    stateWon.result,
    {
      round: 2,
      words: { a: winWord, b: winWord },
      isWin: true,
      timedOut: { a: false, b: false },
      agree: { a: false, b: false },
      winBy: 'same',
    },
    'won 阶段 result'
  );
  eq(stateWon.deadline, null, 'won 阶段无计时器 deadline=null');
  eq(stateWon.agree, { you: false, opponent: false }, 'won 阶段 agree 恒 false');
  eq(stateWon.submitLimitMs, 60000, 'won 阶段 submitLimitMs 保持房间值 60000');
  eq(stateWon.phase, 'won', 'phase=won');
  pass('第二轮通关');

  // ---------- 8. v2.1 结算页「各自退出」（PROTOCOL.md §5.3.1 / §10 第 9 条） ----------
  step('8. game:restart 各自退出：A 先回准备页，B 仍留在结算页，B 再退出后双双 lobby');
  const markRestartA = A.mark();
  const markRestartB = B.mark();
  const restartA = await emitAck(A, 'game:restart', {});
  eq(Object.keys(restartA).sort(), ['ok', 'watching'], 'game:restart ack 字段仅 {ok,watching}');
  eq(restartA, { ok: true, watching: true }, 'A 退出时对方还在结算页 -> watching=true');

  const lobbyA = await waitEvent(
    A,
    'room:state',
    (s) => s.phase === 'lobby' && s.round === 1,
    { since: markRestartA, timeout: 3000, hint: '退出者 A 立刻回 lobby' }
  );
  eq(lobbyA.basis, null, 'restart 后 basis=null');
  eq(lobbyA.result, null, 'restart 后 result=null');
  eq(lobbyA.history, [], 'restart 后 history=[]');
  eq(lobbyA.deadline, null, 'restart 后 deadline=null');
  eq(
    lobbyA.players.map((p) => p.ready),
    [false, false],
    'restart 后 ready 全 false'
  );
  eq(lobbyA.players.map((p) => p.settleDismissed), [true, false], 'A 视角：自己已退出，对方仍在看结算');
  const noticeA8 = await waitEvent(
    A,
    'room:notice',
    (p) => Boolean(p) && p.kind === 'info' && p.text === '已回到房间，可以再来一局',
    { since: markRestartA, timeout: 3000, hint: '退出者收到定向 info notice' }
  );
  eq(noticeA8.text, '已回到房间，可以再来一局', '退出者 notice 文案与协议一致');
  eq(
    B.log
      .slice(markRestartB)
      .filter((e) => e.event === 'room:notice' && noticeOf(e).kind === 'info').length,
    0,
    'info notice 不再广播给未退出的人（改定向）'
  );
  eq((await emitAck(A, 'player:ready', { ready: true })), { ok: true }, '退出者自己可以点准备');

  const settleB = await waitEvent(B, 'room:state', (s) => s.phase === 'won', {
    since: markRestartB,
    timeout: 3000,
    hint: '对方退出后 B 仍停在 won 视角',
  });
  eq(settleB.phase, 'won', 'B 未被强制踢出结算页');
  eq(settleB.round, 2, 'B 的 won 视角仍停在第 2 轮');
  eq(settleB.basis, { a: wordA, b: wordB }, 'B 的 basis 来自冻结快照');
  eq(settleB.history.length, 2, 'B 的 history 未被清空、未被换成新一轮空数据');
  eq(
    settleB.result,
    {
      round: 2,
      words: { a: winWord, b: winWord },
      isWin: true,
      timedOut: { a: false, b: false },
      agree: { a: false, b: false },
      winBy: 'same',
    },
    'B 看到的 result 等于通关那一刻'
  );
  eq(settleB.deadline, null, '留守者 won 视角 deadline=null');
  eq(settleB.submitted, { you: false, opponent: false }, '留守者 won 视角 submitted 全 false');
  eq(settleB.agree, { you: false, opponent: false }, '留守者 won 视角 agree 全 false');
  eq(settleB.submitLimitMs, 60000, '留守者 won 视角也下发房间 submitLimitMs=60000');
  eq(settleB.players.map((p) => p.settleDismissed), [true, false], 'B 视角 players.settleDismissed');
  const noticeB8 = await waitEvent(
    B,
    'room:notice',
    (p) => Boolean(p) && p.kind === 'system' && p.text === '对方已经回到房间等你，看完点「再来一局」',
    { since: markRestartB, timeout: 3000, hint: '留守者收到定向 system notice' }
  );
  eq(noticeB8.kind, 'system', '留守者 notice kind=system');
  await sleep(400);
  eq(
    B.log
      .slice(markRestartB)
      .filter((e) => e.event === 'room:state' && stateOf(e).phase === 'lobby').length,
    0,
    'B 在整个过程中没有收到过 lobby 状态（不会闪回准备页）'
  );
  eq(
    A.log.slice(markRestartA).filter((e) => e.event === 'round:countdown').length,
    0,
    '有人还在看结算时对局不会开始'
  );
  eq(asError(await emitAck(B, 'player:ready', { ready: true })).error, 'BAD_PHASE', '留守者点准备被硬拒 BAD_PHASE');
  eq(asError(await emitAck(B, 'round:next', {})).error, 'BAD_PHASE', '留守者 won 视角下 round:next 也拒绝');

  eq(
    await emitAck(B, 'game:restart', {}),
    { ok: true, watching: false },
    'B 再退出后没人留守 -> watching=false'
  );
  const lobbyB = await waitEvent(
    B,
    'room:state',
    (s) => s.phase === 'lobby' && s.round === 1,
    { since: markRestartB, timeout: 3000, hint: 'B 退出后看到真实 lobby' }
  );
  eq(lobbyB.history, [], 'B 退出后看到真实 history=[]');
  eq(lobbyB.result, null, 'B 退出后看到真实 result=null');
  eq(lobbyB.players.map((p) => p.settleDismissed), [true, true], '全部退出后 players 标记均为 true');
  const lobbyA2 = await waitEvent(
    A,
    'room:state',
    (s) => s.players.length === 2 && s.players.every((p) => p.settleDismissed),
    { since: markRestartA, timeout: 3000, hint: 'A 看到双方都已退出' }
  );
  eq(lobbyA2.phase, 'lobby', '全部退出后 A 仍在 lobby');
  eq(asError(await emitAck(B, 'game:restart', {})).error, 'BAD_PHASE', '已退出的人再点 restart -> BAD_PHASE（幂等拒绝）');
  pass('结算页各自退出（§5.3.1 / §10.9）');

  // ---------- 8b. v2 同意词通关全链路（PROTOCOL.md §10 第 2、3 条） ----------
  step('8b. 同意词链路：首票只记录票面 -> 停留 reveal -> 撤票 -> 再投 -> 手动跨轮清零 -> 双票通关');
  const markAgreeA = A.mark();
  const markAgreeB = B.mark();
  eq((await emitAck(A, 'player:ready', { ready: true })).ok, true, '同意局：A ready');
  eq((await emitAck(B, 'player:ready', { ready: true })).ok, true, '同意局：B ready');
  await waitEvent(A, 'round:countdown', (p) => Boolean(p) && p.round === 1, {
    since: markAgreeA,
    timeout: 5000,
    hint: '同意局倒计时开始',
  });
  const agreeCountdownState = await waitEvent(
    A,
    'room:state',
    (s) => s.phase === 'countdown' && s.round === 1,
    { since: markAgreeA, timeout: 3000 }
  );
  eq(
    agreeCountdownState.players.map((p) => p.settleDismissed),
    [false, false],
    '_startCountdown 兜底：新一局开始时 settleDismissed 全部复位'
  );
  await waitEvent(A, 'round:open', (p) => Boolean(p) && p.round === 1, {
    since: markAgreeA,
    timeout: 6000,
    hint: '同意局输入开放',
  });

  const earlyAgree = asError(await emitAck(A, 'round:agree', { agree: true }));
  eq(earlyAgree.error, 'BAD_PHASE', 'submitting 阶段投 agree -> BAD_PHASE');
  const earlyAgreeNoRoom = asError(await emitAck(D, 'round:agree', { agree: true }));
  eq(earlyAgreeNoRoom.error, 'NOT_IN_ROOM', '不在房间投 agree -> NOT_IN_ROOM');

  eq((await emitAck(A, 'round:submit', { word: '苹果' })).ok, true, '同意局首轮 A 提交');
  eq((await emitAck(B, 'round:submit', { word: '云朵' })).ok, true, '同意局首轮 B 提交');
  const agreeReveal1 = await waitEvent(A, 'round:reveal', (p) => Boolean(p) && p.round === 1, {
    since: markAgreeA,
    timeout: 5000,
  });
  eq(agreeReveal1.isWin, false, '同意局首轮判定不同，停在 reveal');
  eq(agreeReveal1.winBy, null, '同意局首轮 winBy=null');

  // A 投出第一票 -> 仅记录票面（不冻结推进、不设/清计时器）
  const markFreeze = A.mark();
  const markFreezeB = B.mark();
  const voteTrueA = await emitAck(A, 'round:agree', { agree: true });
  eq(Object.keys(voteTrueA).sort(), ['agree', 'ok', 'winBy'], 'round:agree ack 仅 {ok,agree,winBy}');
  eq(voteTrueA, { ok: true, agree: { a: true, b: false }, winBy: null }, 'A 首票 ack');
  const frozenA = await waitEvent(
    A,
    'room:state',
    (s) => s.phase === 'reveal' && s.agree.you === true,
    { since: markFreeze, timeout: 3000, hint: 'A 看到自己的票' }
  );
  eq(frozenA.agree, { you: true, opponent: false }, 'A 视角 agree.you=true / opponent=false');
  eq(frozenA.deadline, null, 'A 视角 reveal 的 deadline 恒为 null（没有自动推进计时器）');
  const frozenB = await waitEvent(
    B,
    'room:state',
    (s) => s.phase === 'reveal' && s.agree.opponent === true,
    { since: markFreezeB, timeout: 3000, hint: 'B 看到对方的票' }
  );
  eq(frozenB.agree, { you: false, opponent: true }, 'B 视角 agree.you=false / opponent=true');
  eq(frozenB.deadline, null, 'B 视角 deadline=null');
  eq(
    await emitAck(A, 'round:agree', { agree: true }),
    { ok: true, agree: { a: true, b: false }, winBy: null },
    '重复投 true 幂等且不报错'
  );

  // 投票不改变推进方式：等待一段真实时间仍停在 reveal（reveal 永不自动推进）
  await sleep(1500);
  eq(
    A.log
      .slice(markFreeze)
      .filter((entry) => entry.event === 'round:countdown' || entry.event === 'round:open')
      .map((entry) => entry.event),
    [],
    '等待 1500ms 后仍无 round:countdown / round:open（reveal 永不自动推进）'
  );
  const frozenStates = A.log
    .slice(markFreeze)
    .filter((entry) => entry.event === 'room:state')
    .map((entry) => stateOf(entry));
  const lastFrozen = frozenStates[frozenStates.length - 1];
  eq(lastFrozen.phase, 'reveal', '等待期间 phase 仍为 reveal');
  eq(lastFrozen.deadline, null, '等待期间 deadline 仍为 null');
  eq(lastFrozen.agree, { you: true, opponent: false }, '等待期间票面保持不变');

  // 撤票：agree.you 变回 false，reveal 依然不会自动推进
  const markWithdraw = A.mark();
  eq(
    await emitAck(A, 'round:agree', { agree: false }),
    { ok: true, agree: { a: false, b: false }, winBy: null },
    '撤票 ack：本座位清零'
  );
  const withdrawn = await waitEvent(
    A,
    'room:state',
    (s) => s.phase === 'reveal' && s.agree.you === false,
    { since: markWithdraw, timeout: 3000, hint: 'A 撤票后的 state' }
  );
  eq(withdrawn.agree, { you: false, opponent: false }, '撤票后 agree.you 变回 false');
  eq(withdrawn.deadline, null, '撤票后 deadline 仍为 null');
  await sleep(700);
  eq(
    A.log.slice(markWithdraw).filter((entry) => entry.event === 'round:countdown').length,
    0,
    '撤票后依然不会自动推进'
  );

  // 再投票 + 手动下一轮：上一轮票面必须清零（跨轮不串）
  eq(
    await emitAck(A, 'round:agree', { agree: true }),
    { ok: true, agree: { a: true, b: false }, winBy: null },
    'A 重新投 true'
  );
  const markNextAgree = A.mark();
  const markNextAgreeB = B.mark();
  eq(await emitAck(A, 'round:next', {}), { ok: true }, '冻结后仍可 round:next 手动继续');
  const agreeCountdown2 = await waitEvent(A, 'round:countdown', (p) => Boolean(p) && p.round === 2, {
    since: markNextAgree,
    timeout: 4000,
    hint: 'round:next 立即进入下一轮',
  });
  eq(agreeCountdown2.round, 2, '冻结后手动进入第二轮');
  const clearedRound2 = await waitEvent(
    A,
    'room:state',
    (s) => s.round === 2 && s.phase === 'countdown',
    { since: markNextAgree, timeout: 3000 }
  );
  eq(clearedRound2.agree, { you: false, opponent: false }, '跨轮：上一轮的 agree 票已清零');
  eq(clearedRound2.submitLimitMs, 60000, '跨轮：submitLimitMs 保持房间值 60000');
  const clearedRound2B = await waitEvent(
    B,
    'room:state',
    (s) => s.round === 2 && s.phase === 'countdown',
    { since: markNextAgreeB, timeout: 3000 }
  );
  eq(clearedRound2B.agree, { you: false, opponent: false }, '跨轮：B 侧同样清零');

  await waitEvent(A, 'round:open', (p) => Boolean(p) && p.round === 2, {
    since: markNextAgree,
    timeout: 6000,
  });
  eq((await emitAck(A, 'round:submit', { word: '左边' })).ok, true, '同意局第二轮 A 提交');
  const markReveal2 = B.mark();
  eq((await emitAck(B, 'round:submit', { word: '右边' })).ok, true, '同意局第二轮 B 提交');
  const agreeReveal2 = await waitEvent(B, 'round:reveal', (p) => Boolean(p) && p.round === 2, {
    since: markReveal2,
    timeout: 5000,
  });
  eq(agreeReveal2.agree, { a: false, b: false }, '第二轮 reveal 载荷 agree 全 false（未串轮）');
  eq(agreeReveal2.winBy, null, '第二轮 reveal 载荷 winBy=null');

  // 双票齐 -> winBy=agree 通关
  const markWinAgree = A.mark();
  const markWinAgreeB = B.mark();
  eq(
    await emitAck(A, 'round:agree', {}),
    { ok: true, agree: { a: true, b: false }, winBy: null },
    'agree 入参缺省视为 true'
  );
  eq(
    await emitAck(B, 'round:agree', { agree: true }),
    { ok: true, agree: { a: true, b: true }, winBy: 'agree' },
    '两票齐 -> winBy=agree'
  );
  const noticeA = await waitEvent(A, 'room:notice', (p) => Boolean(p) && p.kind === 'system', {
    since: markWinAgree,
    timeout: 3000,
    hint: '同意词通关 system notice',
  });
  eq(noticeA, { kind: 'system', text: '双方都确认是同意词，通关！' }, 'A 收到通关 system notice');
  const noticeB = await waitEvent(B, 'room:notice', (p) => Boolean(p) && p.kind === 'system', {
    since: markWinAgreeB,
    timeout: 3000,
  });
  eq(noticeB, { kind: 'system', text: '双方都确认是同意词，通关！' }, 'B 收到相同 system notice');

  const wonAgree = await waitEvent(A, 'room:state', (s) => s.phase === 'won', {
    since: markWinAgree,
    timeout: 3000,
  });
  eq(wonAgree.round, 2, '同意词通关停在第二轮');
  eq(wonAgree.result?.isWin, true, 'won：result.isWin=true');
  eq(wonAgree.result?.winBy, 'agree', 'won：result.winBy=agree');
  eq(wonAgree.result?.agree, { a: true, b: true }, 'won：result.agree={a:true,b:true}');
  eq(wonAgree.result?.words, { a: '左边', b: '右边' }, 'won：结果为第二轮两个不同的词');
  eq(wonAgree.deadline, null, 'won：deadline=null');
  eq(wonAgree.agree, { you: false, opponent: false }, 'won 阶段 state.agree 恒 false');
  eq(wonAgree.submitLimitMs, 60000, 'won 阶段 state.submitLimitMs 保持房间值 60000');
  const agreedHistoryLast = wonAgree.history[wonAgree.history.length - 1];
  eq(
    agreedHistoryLast,
    {
      round: 2,
      basis: { a: '苹果', b: '云朵' },
      words: { a: '左边', b: '右边' },
      isWin: true,
      agree: { a: true, b: true },
      winBy: 'agree',
    },
    'history 末项同步为同意词通关'
  );
  eq(wonAgree.history[0].isWin, false, 'history 首轮记录不被改写');
  eq(wonAgree.history[0].winBy, null, 'history 首轮 winBy 仍为 null');
  eq(
    A.log.slice(markWinAgree).filter((entry) => entry.event === 'round:reveal').map((e) => e.event),
    [],
    '同意词通关不重发 round:reveal'
  );
  const wonAgreeB = await waitEvent(B, 'room:state', (s) => s.phase === 'won', {
    since: markWinAgreeB,
    timeout: 3000,
  });
  eq(wonAgreeB.result?.winBy, 'agree', 'B 视角 result.winBy=agree');
  eq(wonAgreeB.agree, { you: false, opponent: false }, 'B 视角 won 阶段 agree 恒 false');
  eq(wonAgreeB.history[wonAgree.history.length - 1].winBy, 'agree', 'B 视角 history 同步');

  eq(asError(await emitAck(A, 'round:agree', { agree: false })).error, 'BAD_PHASE', 'won 阶段撤票 -> BAD_PHASE');
  eq(asError(await emitAck(B, 'round:agree', { agree: true })).error, 'BAD_PHASE', 'won 阶段投票 -> BAD_PHASE');

  // 两人都退出结算页，给后续断线重连用例一个干净局面
  const markBackLobby = A.mark();
  const markBackLobbyB = B.mark();
  eq(
    await emitAck(A, 'game:restart', {}),
    { ok: true, watching: true },
    '同意词通关后 A 先退出：B 仍留守 -> watching=true'
  );
  const lobbyAfterAgree = await waitEvent(
    A,
    'room:state',
    (s) => s.phase === 'lobby' && s.round === 1,
    { since: markBackLobby, timeout: 3000 }
  );
  eq(lobbyAfterAgree.agree, { you: false, opponent: false }, 'restart 后 agree 清零');
  eq(lobbyAfterAgree.submitLimitMs, 60000, 'restart 后 submitLimitMs 保持房间值 60000');
  eq(lobbyAfterAgree.history, [], 'restart 后 history 清空');
  eq(lobbyAfterAgree.result, null, 'restart 后 result=null');
  const agreeSettleB = await waitEvent(
    B,
    'room:state',
    (s) => s.phase === 'won' && Boolean(s.result) && s.result?.winBy === 'agree',
    { since: markBackLobbyB, timeout: 3000, hint: '同意词通关的快照也能支撑留守者视角' }
  );
  eq(agreeSettleB.history[agreeSettleB.history.length - 1].winBy, 'agree', 'B 留守视角读到 agree 通关方式');
  eq(
    agreeSettleB.players.map((p) => p.settleDismissed),
    [true, false],
    'B 视角：A 已退出、B 仍在看结算'
  );
  eq(asError(await emitAck(B, 'player:ready', { ready: true })).error, 'BAD_PHASE', '同意词快照下 B 仍不能准备');
  eq(
    await emitAck(B, 'game:restart', {}),
    { ok: true, watching: false },
    'B 也退出 -> watching=false'
  );
  const lobbyAfterAgreeB = await waitEvent(
    B,
    'room:state',
    (s) => s.phase === 'lobby' && s.round === 1,
    { since: markBackLobbyB, timeout: 3000 }
  );
  eq(lobbyAfterAgreeB.history, [], 'B 退出后同样看到 history=[]（lastGame 已置 null）');
  pass('同意词通关链路（§10.2 / §10.3）');

  // ---------- 9. 断线重连（token） ----------
  step('9. 断线重连：带 token 重新 join 恢复座位');
  B.disconnect();
  const markAOffline = A.mark();
  const offlineState = await waitEvent(
    A,
    'room:state',
    (s) => {
      const b = s.players.find((p) => p.seat === 'b');
      return b !== undefined && b.connected === false;
    },
    { since: markAOffline, timeout: 4000, hint: 'B 断线后 A 看到 connected=false' }
  );
  eq(offlineState.phase, 'lobby', '断线后房间保留在 lobby');

  const B2 = await connectClient('B2');
  const markAOnline = A.mark();
  const rejoinB = asOk(await emitAck(B2, 'room:join', { code, name: '小红', token: tokenB }));
  eq(rejoinB.ok, true, '带 token 重连成功');
  eq(rejoinB.code, code, '重连返回房间码');
  eq(rejoinB.seat, 'b', '重连恢复 seat b');
  eq(rejoinB.token, tokenB, 'token 不变');
  eq(rejoinB.state.you, { seat: 'b', name: '小红', isHost: false }, '重连后 you 视角恢复');
  eq(rejoinB.state.phase, 'lobby', '重连后 phase 正确');
  const bPlayerBack = rejoinB.state.players.find((p) => p.seat === 'b');
  eq(
    { connected: bPlayerBack?.connected, isYou: bPlayerBack?.isYou },
    { connected: true, isYou: true },
    '重连后 connected=true / isYou=true'
  );
  await waitEvent(
    A,
    'room:state',
    (s) => {
      const b = s.players.find((p) => p.seat === 'b');
      return b !== undefined && b.connected === true;
    },
    { since: markAOnline, timeout: 3000, hint: 'A 看到 B 重新连接' }
  );
  pass('token 重连');

  // ---------- 10. 旧连接被顶替 ----------
  step('10. 旧连接被顶替（REPLACED）');
  const A2 = await connectClient('A2');
  const markReplaced = A.mark();
  const rejoinA = asOk(await emitAck(A2, 'room:join', { code, name: '小明', token: tokenA }));
  eq(rejoinA.ok, true, 'A 用 token 在新连接恢复');
  eq(rejoinA.seat, 'a', '恢复 seat a');
  eq(rejoinA.state.you.isHost, true, 'A 仍是 host');
  const replaced = await waitEvent(A, 'room:error', (p) => Boolean(p) && p.code === 'REPLACED', {
    since: markReplaced,
    timeout: 4000,
    hint: '旧连接收到 REPLACED',
  });
  ok(typeof replaced.message === 'string' && replaced.message.length > 0, 'REPLACED 带中文 message');

  const staleSubmit = asError(await emitAck(A, 'round:submit', { word: '幽灵' }));
  eq(staleSubmit.error, 'NOT_IN_ROOM', '被顶替的旧连接不能继续操作');
  pass('REPLACED 顶替');

  // ---------- 11. 离开 / host 转移 / 删房 ----------
  step('11. 离开、host 转移、0 人删房');
  const markLeave = B2.mark();
  eq(await emitAck(A2, 'room:leave', {}), { ok: true }, 'A 离开成功');
  const afterLeave = await waitEvent(B2, 'room:state', (s) => s.players.length === 1, {
    since: markLeave,
    timeout: 3000,
    hint: '剩余玩家收到 state',
  });
  eq(afterLeave.phase, 'lobby', 'lobby 中对手离开不中止');
  eq(afterLeave.players[0].seat, 'b', '剩余玩家仍是 seat b');
  eq(afterLeave.you.isHost, true, 'host 转移给剩余玩家');
  eq(afterLeave.players[0].isHost, true, 'players[].isHost 同步');

  eq(await emitAck(B2, 'room:leave', {}), { ok: true }, 'B 离开成功');
  await sleep(300);
  const health2 = await fetchJson('/health');
  eq(health2.body, { ok: true, rooms: 0 }, '0 人后房间被删除');

  pass('离开与删房');

  // ---------- 11b. 房间级填词时限（submitLimitMs）端到端 ----------
  step('11b. 房间级填词时限：非法值拒绝 / 缺省 1 分钟 / 自定义 3 分钟 / 不限时 / restart 保持');
  const invalidLimitNumber = asError(
    await emitAck(D, 'room:create', {
      name: '非法甲',
      submitLimitMs: 90000 as unknown as CreatePayload['submitLimitMs'],
    })
  );
  eq(invalidLimitNumber.error, 'INVALID_SUBMIT_LIMIT', '90000 不在可选项 -> INVALID_SUBMIT_LIMIT');
  eq(
    invalidLimitNumber.message,
    '填词时限只能是不限时 / 1 分钟 / 3 分钟 / 5 分钟',
    'INVALID_SUBMIT_LIMIT 中文提示与协议一致'
  );
  eq(
    Object.keys(invalidLimitNumber).sort(),
    ['error', 'message', 'ok'],
    '非法时限错误返回字段仅 {ok,error,message}'
  );
  const invalidLimitString = asError(
    await emitAck(D, 'room:create', {
      name: '非法乙',
      submitLimitMs: '60000' as unknown as CreatePayload['submitLimitMs'],
    })
  );
  eq(invalidLimitString.error, 'INVALID_SUBMIT_LIMIT', '字符串 "60000" -> INVALID_SUBMIT_LIMIT');
  eq((await fetchJson('/health')).body.rooms, 0, '非法 submitLimitMs 不会创建房间');

  const E = await connectClient('E');
  const F = await connectClient('F');

  // null 视为缺省 60000
  const markNullLimit = E.mark();
  const nullLimitCreated = asOk(
    await emitAck(E, 'room:create', {
      name: '缺省甲',
      submitLimitMs: null as unknown as CreatePayload['submitLimitMs'],
    })
  );
  const nullLimitState = await waitEvent(
    E,
    'room:state',
    (s) => s.code === nullLimitCreated.code && s.phase === 'lobby',
    { since: markNullLimit, timeout: 3000 }
  );
  eq(nullLimitState.submitLimitMs, 60000, 'submitLimitMs=null 按缺省 60000 处理');
  eq(await emitAck(E, 'room:leave', {}), { ok: true }, '缺省房间用完即离开');

  // 自定义 180000（3 分钟）
  const mark180 = E.mark();
  const created180 = asOk(
    await emitAck(E, 'room:create', { name: '三分钟甲', submitLimitMs: 180000 })
  );
  const code180 = created180.code;
  const lobby180 = await waitEvent(E, 'room:state', (s) => s.code === code180, {
    since: mark180,
    timeout: 3000,
  });
  eq(lobby180.submitLimitMs, 180000, '创建时传 180000 -> lobby state.submitLimitMs=180000');
  asOk(await emitAck(F, 'room:join', { code: code180, name: '三分钟乙' }));
  const mark180Open = E.mark();
  eq((await emitAck(E, 'player:ready', { ready: true })).ok, true, '180000 房：A ready');
  eq((await emitAck(F, 'player:ready', { ready: true })).ok, true, '180000 房：B ready');
  const open180 = await waitEvent(E, 'round:open', (p) => Boolean(p) && p.round === 1, {
    since: mark180Open,
    timeout: 6000,
    hint: '180000 房进入提交阶段',
  });
  ok(open180.deadline !== null, '180000 房 round:open.deadline 不为 null');
  const delta180 = open180.deadline === null ? -1 : open180.deadline - Date.now();
  ok(
    delta180 > 170000 && delta180 <= 182000,
    `180000 房 round:open.deadline ≈ now + 180000（实际 ${delta180}ms）`
  );
  const submitting180 = await waitEvent(E, 'room:state', (s) => s.phase === 'submitting', {
    since: mark180Open,
    timeout: 3000,
  });
  eq(submitting180.submitLimitMs, 180000, '180000 房 submitting 阶段 submitLimitMs 保持 180000');
  const limitWord = '同一片天空';
  eq((await emitAck(E, 'round:submit', { word: limitWord })).ok, true, '180000 房 A 提交');
  eq((await emitAck(F, 'round:submit', { word: limitWord })).ok, true, '180000 房 B 提交同词');
  const reveal180 = await waitEvent(E, 'round:reveal', (p) => Boolean(p) && p.round === 1, {
    since: mark180Open,
    timeout: 5000,
  });
  eq(reveal180.isWin, true, '180000 房同词通关');
  const markRestart180 = E.mark();
  eq(
    await emitAck(E, 'game:restart', {}),
    { ok: true, watching: true },
    '180000 房 A 退出结算（B 仍留守）'
  );
  const lobby180After = await waitEvent(
    E,
    'room:state',
    (s) => s.phase === 'lobby' && s.round === 1,
    { since: markRestart180, timeout: 3000 }
  );
  eq(
    lobby180After.submitLimitMs,
    180000,
    'game:restart 后新 lobby 的 submitLimitMs 仍为 180000（房间级参数整局不变）'
  );
  eq((await emitAck(F, 'game:restart', {})).ok, true, '180000 房 B 也退出结算');
  eq((await emitAck(E, 'room:leave', {})).ok, true, '180000 房 A 离开');
  eq((await emitAck(F, 'room:leave', {})).ok, true, '180000 房 B 离开');

  // 不限时（0）
  const markUnlimited = E.mark();
  const createdUnlimited = asOk(
    await emitAck(E, 'room:create', { name: '不限时甲', submitLimitMs: 0 })
  );
  const codeUnlimited = createdUnlimited.code;
  const lobbyUnlimited = await waitEvent(E, 'room:state', (s) => s.code === codeUnlimited, {
    since: markUnlimited,
    timeout: 3000,
  });
  eq(lobbyUnlimited.submitLimitMs, 0, '创建时传 0 -> state.submitLimitMs=0（不限时）');
  asOk(await emitAck(F, 'room:join', { code: codeUnlimited, name: '不限时乙' }));
  const markUnlimitedOpen = E.mark();
  eq((await emitAck(E, 'player:ready', { ready: true })).ok, true, '不限时房：A ready');
  eq((await emitAck(F, 'player:ready', { ready: true })).ok, true, '不限时房：B ready');
  const openUnlimited = await waitEvent(E, 'round:open', (p) => Boolean(p) && p.round === 1, {
    since: markUnlimitedOpen,
    timeout: 6000,
    hint: '不限时房进入提交阶段',
  });
  eq(openUnlimited.deadline, null, '不限时房 round:open.deadline=null');
  const stateUnlimited = await waitEvent(E, 'room:state', (s) => s.phase === 'submitting', {
    since: markUnlimitedOpen,
    timeout: 3000,
  });
  eq(stateUnlimited.submitLimitMs, 0, '不限时房 submitting 阶段 submitLimitMs=0');
  eq(stateUnlimited.deadline, null, '不限时房 submitting 阶段 deadline=null');
  const markUnlimitedWait = E.mark();
  await sleep(1300);
  eq(
    E.log
      .slice(markUnlimitedWait)
      .filter((entry) => entry.event === 'round:reveal' || entry.event === 'round:countdown')
      .map((entry) => entry.event),
    [],
    '不限时房等待 1300ms 后仍无 round:reveal / round:countdown（不会自动揭晓）'
  );
  eq((await emitAck(E, 'round:submit', { word: '月亮' })).ok, true, '不限时房 A 提交');
  // 提交只会触发一次 state 广播；此刻仍是 submitting，证明等待期间没有被超时推进
  const unlimitedAfterWait = await waitEvent(
    E,
    'room:state',
    (s) => s.phase === 'submitting' && s.submitted.you === true,
    { since: markUnlimitedWait, timeout: 3000 }
  );
  eq(unlimitedAfterWait.phase, 'submitting', '不限时房等待后仍停在 submitting');
  eq(unlimitedAfterWait.deadline, null, '不限时房等待后 deadline 仍为 null');
  eq(unlimitedAfterWait.submitLimitMs, 0, '不限时房等待后 submitLimitMs 仍为 0');
  eq((await emitAck(F, 'round:submit', { word: '星星' })).ok, true, '不限时房 B 提交');
  const revealUnlimited = await waitEvent(E, 'round:reveal', (p) => Boolean(p) && p.round === 1, {
    since: markUnlimitedOpen,
    timeout: 5000,
    hint: '不限时房双方提交后正常揭晓',
  });
  eq(revealUnlimited.words, { a: '月亮', b: '星星' }, '不限时房双方提交后正常 round:reveal');
  const stateRevealUnlimited = await waitEvent(E, 'room:state', (s) => s.phase === 'reveal', {
    since: markUnlimitedOpen,
    timeout: 3000,
  });
  eq(stateRevealUnlimited.deadline, null, '不限时房 reveal 阶段 deadline=null（不自动推进）');
  eq((await emitAck(E, 'room:leave', {})).ok, true, '不限时房 A 离开');
  eq((await emitAck(F, 'room:leave', {})).ok, true, '不限时房 B 离开');
  await sleep(200);
  eq((await fetchJson('/health')).body.rooms, 0, '时限用例结束后房间均已删除');
  pass('房间级填词时限（submitLimitMs）');

  // ---------- 11c. _openRound 时限分支（直接驱动状态机） ----------
  step('11c. _openRound 时限分支：默认 60s / 不限时（直接驱动，不等真实计时）');
  const gOpen = new GameModule();
  const openEvents: { event: string; payload: unknown }[] = [];
  gOpen.emitToRoom = (
    _roomCode: string,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    openEvents.push({ event, payload });
  };

  const openDefaultRoom = gOpen.rooms.get(
    asOk(gOpen.createRoom('open-def', { name: '甲' })).code
  ) as Room;
  eq(openDefaultRoom.submitLimitMs, 60000, '缺省房间 Room.submitLimitMs=60000');
  openDefaultRoom.phase = 'countdown';
  const openDefaultAt = Date.now();
  gOpen._openRound(openDefaultRoom);
  eq(openDefaultRoom.phase, 'submitting', '默认房间 _openRound 后进入 submitting');
  ok(openDefaultRoom.deadline !== null, '默认房间 _openRound 设置 deadline');
  if (openDefaultRoom.deadline !== null) {
    ok(
      openDefaultRoom.deadline - openDefaultAt >= 59000 &&
        openDefaultRoom.deadline - openDefaultAt <= 61000,
      `默认房间 deadline ≈ now + 60000（实际 ${openDefaultRoom.deadline - openDefaultAt}ms）`
    );
  }
  ok(openDefaultRoom.timer !== null, '默认房间 _openRound 安装了超时计时器');
  const openPayloadDefault = openEvents
    .filter((entry) => entry.event === 'round:open')
    .pop()?.payload as RoundOpenPayload;
  eq(openPayloadDefault.deadline, openDefaultRoom.deadline, 'round:open 载荷带同一个 deadline');

  const openFreeRoom = gOpen.rooms.get(
    asOk(gOpen.createRoom('open-free', { name: '甲', submitLimitMs: 0 })).code
  ) as Room;
  eq(openFreeRoom.submitLimitMs, 0, '不限时房间 Room.submitLimitMs=0');
  openFreeRoom.phase = 'countdown';
  const beforeFreeEvents = openEvents.length;
  const openFreeAt = Date.now();
  gOpen._openRound(openFreeRoom);
  eq(openFreeRoom.deadline, null, '不限时 _openRound：deadline=null');
  eq(openFreeRoom.timer, null, '不限时 _openRound：不安装超时计时器');
  ok(Date.now() - openFreeAt < 1000, '不限时 _openRound 立即返回（不等任何计时器）');
  const openPayloadFree = openEvents
    .slice(beforeFreeEvents)
    .find((entry) => entry.event === 'round:open')?.payload as RoundOpenPayload;
  eq(openPayloadFree.deadline, null, '不限时 round:open 载荷 deadline=null');

  const openLongRoom = gOpen.rooms.get(
    asOk(gOpen.createRoom('open-long', { name: '甲', submitLimitMs: 180000 })).code
  ) as Room;
  openLongRoom.phase = 'countdown';
  const openLongAt = Date.now();
  gOpen._openRound(openLongRoom);
  ok(openLongRoom.deadline !== null, '180000 房间 _openRound 设置 deadline');
  if (openLongRoom.deadline !== null) {
    const longDelta = openLongRoom.deadline - openLongAt;
    ok(longDelta >= 179000 && longDelta <= 181000, `180000 房间 deadline ≈ now + 180000（实际 ${longDelta}ms）`);
  }
  ok(openLongRoom.timer !== null, '180000 房间 _openRound 安装了超时计时器');
  gOpen.shutdown();
  pass('_openRound 时限分支');

  // ---------- 12. 超时自动提交（直接驱动状态机，不等待真实 60s） ----------
  step('12. 超时自动填「词穷」并正常判定');
  const gTimeout = new GameModule();
  const timeoutRoomCreated = asOk(gTimeout.createRoom('timeout-a', { name: '甲' }));
  gTimeout.joinRoom('timeout-b', { code: timeoutRoomCreated.code, name: '乙' });
  const timeoutRoom = gTimeout.rooms.get(timeoutRoomCreated.code) as Room;
  timeoutRoom.phase = 'submitting';
  timeoutRoom.submissions = { a: { word: '苹果', timedOut: false }, b: null };
  const timeoutReveals: RevealPayload[] = [];
  gTimeout.emitToRoom = (
    _roomCode: string,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    if (event === 'round:reveal') timeoutReveals.push(payload as RevealPayload);
  };
  gTimeout._onSubmitTimeout(timeoutRoom);
  ok(timeoutReveals.length > 0, '超时后仍会揭晓');
  const timeoutReveal = timeoutReveals[0];
  eq(timeoutReveal.words, { a: '苹果', b: '词穷' }, '未提交者自动填「词穷」');
  eq(timeoutReveal.timedOut, { a: false, b: true }, 'timedOut 标记正确');
  eq(timeoutReveal.isWin, false, '「苹果」与「词穷」判定为不同');
  eq(timeoutRoom.phase, 'reveal', '不同 -> 进入 reveal');
  eq(timeoutRoom.deadline, null, '超时揭晓后进入 reveal，deadline=null');
  eq(timeoutRoom.timer, null, '超时揭晓后不残留自动推进计时器');
  gTimeout.shutdown();
  pass('超时兜底');

  // ---------- 13. 对局中离开 -> OPPONENT_LEFT / aborted ----------
  step('13. 对局中离开：OPPONENT_LEFT + phase=aborted');
  const gLeave = new GameModule();
  const leaveCreated = asOk(gLeave.createRoom('leave-a', { name: '甲' }));
  gLeave.joinRoom('leave-b', { code: leaveCreated.code, name: '乙' });
  const leaveRoom = gLeave.rooms.get(leaveCreated.code) as Room;
  leaveRoom.phase = 'submitting';
  leaveRoom.deadline = Date.now() + 60000;
  const errors: { seat: Seat; payload: RoomErrorPayload }[] = [];
  const states: { seat: Seat; payload: PublicRoomState }[] = [];
  gLeave.emitToPlayer = (
    player: Player,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    if (event === 'room:error') errors.push({ seat: player.seat, payload: payload as RoomErrorPayload });
    if (event === 'room:state') states.push({ seat: player.seat, payload: payload as PublicRoomState });
  };
  eq(gLeave.leaveRoom('leave-b'), { ok: true }, '对局中离开成功');
  eq(leaveRoom.phase, 'aborted', '剩余玩家看到 aborted');
  eq(errors.length, 1, '仅剩余玩家收到 room:error');
  eq(errors[0].seat, 'a', '错误发给剩余玩家');
  eq(errors[0].payload.code, 'OPPONENT_LEFT', '错误码 OPPONENT_LEFT');
  eq(leaveRoom.deadline, null, 'aborted 清空 deadline');
  ok(leaveRoom.players.length === 1 && leaveRoom.players[0].isHost, '剩余玩家成为 host');
  eq(states[states.length - 1].payload.phase, 'aborted', '最后一次 state 为 aborted');
  gLeave.shutdown();
  pass('对局中离开');

  // ---------- 14. round:next 手动跳过 ----------
  step('14. round:next 手动进入下一轮');
  const gNext = new GameModule();
  const nextCreated = asOk(gNext.createRoom('next-a', { name: '甲' }));
  gNext.joinRoom('next-b', { code: nextCreated.code, name: '乙' });
  const nextRoom = gNext.rooms.get(nextCreated.code) as Room;
  nextRoom.phase = 'reveal';
  nextRoom.result = {
    round: 1,
    words: { a: '甲', b: '乙' },
    isWin: false,
    timedOut: { a: false, b: false },
    agree: { a: false, b: false },
    winBy: null,
  };
  eq(gNext.nextRound('next-b'), { ok: true }, 'reveal 阶段可手动下一轮');
  eq(nextRoom.phase, 'countdown', '手动跳过后进入 countdown');
  eq(nextRoom.round, 2, 'round + 1');
  eq(nextRoom.basis, { a: '甲', b: '乙' }, 'basis = 上一轮两词');
  eq(asError(gNext.nextRound('next-b')).error, 'BAD_PHASE', '非 reveal 阶段 -> BAD_PHASE');
  gNext.shutdown();
  pass('手动下一轮');

  // ---------- 15. 全员离线超 10 分钟清理 ----------
  step('15. 全员离线超过 10 分钟的房间被周期清理');
  const gSweep = new GameModule();
  const sweepCreated = asOk(gSweep.createRoom('sweep-a', { name: '甲' }));
  const sweepRoom = gSweep.rooms.get(sweepCreated.code) as Room;
  sweepRoom.players[0].connected = false;
  sweepRoom.players[0].socketId = null;
  sweepRoom.allOfflineAt = Date.now() - constants.OFFLINE_ROOM_TTL_MS + 60 * 1000;
  gSweep.sweep();
  eq(gSweep.roomCount(), 1, '未满 10 分钟不清理');
  sweepRoom.allOfflineAt = Date.now() - constants.OFFLINE_ROOM_TTL_MS - 1000;
  gSweep.sweep();
  eq(gSweep.roomCount(), 0, '全员离线超 10 分钟删房');
  gSweep.shutdown();
  pass('离线房间清理');

  // ---------- 16. setAgree 状态机内部规则（直接驱动，不等待真实计时） ----------
  step('16. setAgree 内部规则：票面、幂等、通关写 history/notice、视角门控、跨轮清零');
  const gAgree = new GameModule();
  const agreeRoomEvents: { event: string; payload: unknown }[] = [];
  const agreePlayerEvents: { seat: Seat; event: string; payload: unknown }[] = [];
  const agreeCreated = asOk(gAgree.createRoom('agree-a', { name: '甲' }));
  gAgree.joinRoom('agree-b', { code: agreeCreated.code, name: '乙' });
  const agreeRoom = gAgree.rooms.get(agreeCreated.code) as Room;
  gAgree.emitToRoom = (
    _roomCode: string,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    agreeRoomEvents.push({ event, payload });
  };
  gAgree.emitToPlayer = (
    player: Player,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    agreePlayerEvents.push({ seat: player.seat, event, payload });
  };
  eq(agreeRoom.agree, { a: false, b: false }, 'createRoom：Room.agree 初值全 false');
  eq(agreeRoom.submitLimitMs, 60000, 'createRoom：Room.submitLimitMs 初值 60000（缺省）');
  eq(asError(gAgree.setAgree('agree-a', true)).error, 'BAD_PHASE', 'lobby 阶段投票 -> BAD_PHASE');
  eq(asError(gAgree.setAgree('ghost-socket', true)).error, 'NOT_IN_ROOM', '不在房间投票 -> NOT_IN_ROOM');

  agreeRoom.phase = 'reveal';
  // 新语义：reveal 阶段 deadline 恒为 null，也不存在任何自动推进计时器
  agreeRoom.deadline = null;
  agreeRoom.result = {
    round: 1,
    words: { a: '苹果', b: '云朵' },
    isWin: false,
    timedOut: { a: false, b: false },
    agree: { a: false, b: false },
    winBy: null,
  };
  agreeRoom.history.push({
    round: 1,
    basis: null,
    words: { a: '苹果', b: '云朵' },
    isWin: false,
    agree: { a: false, b: false },
    winBy: null,
  });
  eq(agreeRoom.timer, null, 'reveal 阶段初始没有计时器（揭晓永不自动推进）');

  eq(gAgree.setAgree('agree-a'), { ok: true, agree: { a: true, b: false }, winBy: null }, '入参缺省视为 true');
  eq(agreeRoom.deadline, null, '首票后 deadline 仍为 null');
  eq(agreeRoom.timer, null, '投票不创建计时器（reveal 永不自动推进）');
  eq(agreeRoom.result?.agree, { a: true, b: false }, 'result.agree 反映当前票面');
  eq(agreeRoom.result?.winBy, null, '单票不改 winBy');
  eq(agreeRoom.phase, 'reveal', '单票仍停在 reveal');
  eq(
    agreeRoomEvents.filter((entry) => entry.event === 'round:reveal').length,
    0,
    '投票从不重发 round:reveal'
  );

  eq(
    gAgree.setAgree('agree-a', false),
    { ok: true, agree: { a: false, b: false }, winBy: null },
    '撤票返回清零后的票面'
  );
  eq(agreeRoom.agree, { a: false, b: false }, '撤票只清自己座位');
  eq(agreeRoom.timer, null, '撤票也不创建计时器');
  await sleep(420);
  eq(agreeRoom.phase, 'reveal', '等待 420ms 后仍停在 reveal');
  eq(agreeRoom.deadline, null, '等待 420ms 后 deadline 仍为 null');
  eq(
    agreeRoomEvents.filter(
      (entry) => entry.event === 'round:countdown' || entry.event === 'round:open'
    ).length,
    0,
    'setAgree 从不触发 round:countdown / round:open'
  );

  eq(asOk(gAgree.setAgree('agree-a', true)).agree, { a: true, b: false }, '重新投票');
  eq(
    gAgree.setAgree('agree-b', true),
    { ok: true, agree: { a: true, b: true }, winBy: 'agree' },
    '后到的一票触发通关'
  );
  eq(agreeRoom.phase, 'won', '两票齐立即 won');
  eq(agreeRoom.deadline, null, 'won 后 deadline=null');
  eq(agreeRoom.result?.isWin, true, '通关：result.isWin=true');
  eq(agreeRoom.result?.winBy, 'agree', '通关：result.winBy=agree');
  eq(agreeRoom.result?.agree, { a: true, b: true }, '通关：result.agree 两票齐');
  eq(agreeRoom.history[0].isWin, true, '通关：history 末项 isWin 同步');
  eq(agreeRoom.history[0].winBy, 'agree', '通关：history 末项 winBy 同步');
  eq(agreeRoom.history[0].agree, { a: true, b: true }, '通关：history 末项 agree 同步');
  eq(agreeRoom.history[0].words, { a: '苹果', b: '云朵' }, '通关：history 末项词不被改写');
  eq(agreeRoomEvents.filter((entry) => entry.event === 'round:reveal').length, 0, '通关也不重发 round:reveal');
  eq(
    agreeRoomEvents.filter((entry) => entry.event === 'room:notice').map((entry) => entry.payload),
    [{ kind: 'system', text: '双方都确认是同意词，通关！' }],
    '通关仅发一条 system notice（kind/text 与协议一致）'
  );
  const wonViews = agreePlayerEvents.filter(
    (e) => e.event === 'room:state' && stateOf(e).phase === 'won'
  );
  eq(wonViews.length, 2, '通关后两名玩家各收到一次 won 的 room:state');
  eq(
    wonViews.map((e) => stateOf(e).agree),
    [
      { you: false, opponent: false },
      { you: false, opponent: false },
    ],
    'won 的 state.agree 恒为 false'
  );
  eq(wonViews.map((e) => stateOf(e).submitLimitMs), [60000, 60000], 'won 的 state.submitLimitMs 保持房间值');
  eq(stateOf(wonViews[0]).history[0].winBy, 'agree', 'state.history 下发 winBy');
  eq(stateOf(wonViews[0]).result?.agree, { a: true, b: true }, 'state.result 下发 agree');
  eq(asError(gAgree.setAgree('agree-a', true)).error, 'BAD_PHASE', 'won 阶段再投 -> BAD_PHASE');

  // 视角门控：内部脏值也不得外泄
  agreeRoom.agree = { a: true, b: true };
  const wonDirtyView = gAgree.getState(agreeRoom, agreeRoom.players.find((p) => p.seat === 'a') as Player);
  eq(wonDirtyView.agree, { you: false, opponent: false }, '非 reveal：state.agree 恒 false（脏值也不外泄）');
  eq(wonDirtyView.submitLimitMs, 60000, '非 reveal：state.submitLimitMs 仍下发房间值');
  agreeRoom.phase = 'reveal';
  const dirtyRevealA = gAgree.getState(agreeRoom, agreeRoom.players.find((p) => p.seat === 'a') as Player);
  eq(dirtyRevealA.agree, { you: true, opponent: true }, 'reveal：A 视角 you/opponent');
  eq(dirtyRevealA.submitLimitMs, 60000, 'reveal：state.submitLimitMs 下发房间值');
  agreeRoom.agree = { a: true, b: false };
  eq(
    gAgree.getState(agreeRoom, agreeRoom.players.find((p) => p.seat === 'b') as Player).agree,
    { you: false, opponent: true },
    'reveal：B 视角只看到对方已投'
  );
  agreeRoom.phase = 'lobby';
  eq(
    gAgree.getState(agreeRoom, agreeRoom.players.find((p) => p.seat === 'a') as Player).agree,
    { you: false, opponent: false },
    'lobby：即使 agree.a=true 也恒 false'
  );

  // 跨轮清零（submitLimitMs 是房间级参数，任何换轮 / 重开都不得重置）
  agreeRoom.phase = 'reveal';
  agreeRoom.agree = { a: true, b: true };
  gAgree._advanceRound(agreeRoom);
  eq(agreeRoom.agree, { a: false, b: false }, '_advanceRound 清零 agree');
  eq(agreeRoom.submitLimitMs, 60000, '_advanceRound 不重置 submitLimitMs');
  agreeRoom.agree = { a: true, b: true };
  gAgree._startCountdown(agreeRoom);
  eq(agreeRoom.agree, { a: false, b: false }, '_startCountdown 清零 agree');
  eq(agreeRoom.submitLimitMs, 60000, '_startCountdown 不重置 submitLimitMs');
  agreeRoom.agree = { a: true, b: true };
  agreeRoom.phase = 'won';
  eq(
    gAgree.restart('agree-a'),
    { ok: true, watching: true },
    'won 阶段 restart 成功（对方未退出 -> watching=true）'
  );
  eq(agreeRoom.agree, { a: false, b: false }, 'restart 清零 agree');
  eq(agreeRoom.submitLimitMs, 60000, 'restart 不重置 submitLimitMs');
  eq(agreeRoom.round, 1, 'restart 后 round=1');
  gAgree.shutdown();
  pass('setAgree 内部规则');

  // ---------- 17. v2.1 结算页各自退出的内部规则（PROTOCOL.md §5.3.1） ----------
  step('17. lastGame / settleDismissed：快照视角门控、notice 定向、各清理路径');
  const gSettle = new GameModule();
  const settleRoomEvents: { event: string; payload: unknown }[] = [];
  const settlePlayerEvents: { seat: Seat; event: string; payload: unknown }[] = [];
  const settleCreated = asOk(gSettle.createRoom('settle-a', { name: '甲' }));
  gSettle.joinRoom('settle-b', { code: settleCreated.code, name: '乙' });
  const settleRoom = gSettle.rooms.get(settleCreated.code) as Room;
  gSettle.emitToRoom = (
    _roomCode: string,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    settleRoomEvents.push({ event, payload });
  };
  gSettle.emitToPlayer = (
    player: Player,
    event: keyof ServerToClientEvents,
    payload: unknown
  ): void => {
    settlePlayerEvents.push({ seat: player.seat, event, payload });
  };
  const seatOf = (seat: Seat): Player => {
    const found = settleRoom.players.find((p) => p.seat === seat);
    if (!found) throw new Error(`断言失败：缺少座位 ${seat}`);
    return found;
  };
  eq(settleRoom.lastGame, null, 'createRoom：lastGame 初值 null');
  eq(
    settleRoom.players.map((p) => p.settleDismissed),
    [false, false],
    'createRoom/joinRoom：新玩家 settleDismissed 均为 false'
  );
  eq(asError(gSettle.restart('settle-a')).error, 'BAD_PHASE', 'lobby 阶段 restart -> BAD_PHASE');

  // 伪造一个「同意词通关」的第 3 轮结束局面
  settleRoom.phase = 'won';
  settleRoom.round = 3;
  settleRoom.basis = { a: '云', b: '雾' };
  settleRoom.result = {
    round: 3,
    words: { a: '日', b: '太阳' },
    isWin: true,
    timedOut: { a: false, b: true },
    agree: { a: true, b: true },
    winBy: 'agree',
  };
  settleRoom.history.push({
    round: 1,
    basis: null,
    words: { a: '甲', b: '乙' },
    isWin: false,
    agree: { a: false, b: false },
    winBy: null,
  });
  settleRoom.history.push({
    round: 2,
    basis: { a: '云', b: '雾' },
    words: { a: '丙', b: '丁' },
    isWin: false,
    agree: { a: false, b: false },
    winBy: null,
  });
  settleRoom.history.push({
    round: 3,
    basis: { a: '云', b: '雾' },
    words: { a: '日', b: '太阳' },
    isWin: true,
    agree: { a: true, b: true },
    winBy: 'agree',
  });

  // A 退出：先冻结快照，再走 lobby 重置
  const restart1 = gSettle.restart('settle-a');
  eq(restart1, { ok: true, watching: true }, 'A 先退出：watching=true');
  const lastGame = settleRoom.lastGame;
  if (!lastGame) throw new Error('断言失败：首次 restart 后应存在 lastGame 快照');
  eq(typeof lastGame.endedAt, 'number', 'lastGame.endedAt 是时间戳');
  eq(settleRoom.phase, 'lobby', '首次退出后内部 phase=lobby');
  eq(settleRoom.round, 1, '首次退出后内部 round=1');
  eq(settleRoom.history, [], '首次退出后内部 history=[]');
  eq(settleRoom.result, null, '首次退出后内部 result=null');
  eq(
    settleRoom.players.map((p) => p.settleDismissed),
    [true, false],
    '退出者 true、留守者 false'
  );
  eq(
    settleRoom.players.map((p) => p.ready),
    [false, false],
    '首次退出沿用旧行为：ready 全清'
  );

  // 快照形状与 §5.3 一致
  eq(lastGame.round, 3, '快照 round=3');
  eq(lastGame.basis, { a: '云', b: '雾' }, '快照 basis 与通关那刻一致');
  eq(lastGame.result?.words, { a: '日', b: '太阳' }, '快照 result.words 已冻结');
  eq(lastGame.result?.winBy, 'agree', '快照 result.winBy=agree');
  eq(lastGame.result?.timedOut, { a: false, b: true }, '快照 result.timedOut 形状保持');
  eq(lastGame.history.length, 3, '快照 history 三条');
  eq(lastGame.history[2].isWin, true, '快照 history 末项 isWin=true');
  eq(lastGame.history[0].winBy, null, '快照 history 首轮 winBy=null');

  // 留守者（B）看到假 won；退出者（A）看到真实 lobby
  const viewB = gSettle.getState(settleRoom, seatOf('b'));
  const viewA = gSettle.getState(settleRoom, seatOf('a'));
  eq(viewB.phase, 'won', 'B：仍看到 won 视角');
  eq(viewB.round, 3, 'B：round 来自快照');
  eq(viewB.basis, { a: '云', b: '雾' }, 'B：basis 来自快照');
  eq(viewB.result, settleRoom.lastGame?.result, 'B：result 等于快照 result');
  eq(viewB.history.length, 3, 'B：history 三条（未被清空）');
  eq(viewB.history, settleRoom.lastGame?.history, 'B：history 等于快照 history');
  eq(viewB.deadline, null, 'B：deadline=null');
  eq(viewB.submitted, { you: false, opponent: false }, 'B：submitted 全 false');
  eq(viewB.agree, { you: false, opponent: false }, 'B：agree 全 false');
  eq(viewB.submitLimitMs, 60000, 'B：快照视角也下发房间 submitLimitMs');
  eq(viewB.players.map((p) => p.settleDismissed), [true, false], 'B：players 暴露退出标记');
  eq(viewA.phase, 'lobby', 'A：看到真实 lobby');
  eq(viewA.round, 1, 'A：真实 round=1');
  eq(viewA.history, [], 'A：真实 history=[]');
  eq(viewA.result, null, 'A：真实 result=null');
  eq(viewA.settlePending, true, 'A 视角 settlePending=true（确有快照挂着）');
  eq(viewB.settlePending, true, 'B 视角 settlePending=true（两视角一致）');
  eq(Object.keys(viewB).sort(), Object.keys(viewA).sort(), '两种视角字段集合一致（前端无需新分支）');

  // 幂等与硬拒
  eq(asError(gSettle.restart('settle-a')).error, 'BAD_PHASE', '已退出者再点 restart -> BAD_PHASE');
  eq(asError(gSettle.setReady('settle-b', true)).error, 'BAD_PHASE', '留守者准备 -> BAD_PHASE');
  eq(asError(gSettle.submitWord('settle-b', '词')).error, 'BAD_PHASE', '留守者提交也拒绝（真实相位是 lobby）');
  eq(asError(gSettle.nextRound('settle-b')).error, 'BAD_PHASE', '留守者 round:next 拒绝');
  eq(gSettle.setReady('settle-a', true), { ok: true }, '退出者可以自己准备');
  eq(seatOf('a').ready, true, '退出者 ready 已置位');

  // notice 定向：A 收 info、B 收 system，且不再走房间广播
  eq(
    settlePlayerEvents
      .filter((e) => e.event === 'room:notice' && e.seat === 'a')
      .map((e) => noticeOf(e).text),
    ['已回到房间，可以再来一局'],
    '退出者只收到 info 文案'
  );
  eq(
    settlePlayerEvents
      .filter((e) => e.event === 'room:notice' && e.seat === 'b')
      .map((e) => ({ kind: noticeOf(e).kind, text: noticeOf(e).text })),
    [{ kind: 'system', text: '对方已经回到房间等你，看完点「再来一局」' }],
    '留守者只收到 system 文案'
  );
  eq(settleRoomEvents.filter((e) => e.event === 'room:notice').length, 0, 'restart 的 notice 不再走 _emitRoom 广播');
  eq(settleRoomEvents.filter((e) => e.event === 'round:reveal').length, 0, '退出不产生 round:reveal');

  // 留守者断线重连后仍在结算页
  gSettle.disconnect('settle-b');
  const tokenB17 = seatOf('b').token;
  const reconnectB = asOk(
    gSettle.joinRoom('settle-b-new', {
      code: settleCreated.code,
      name: '乙',
      token: tokenB17,
    })
  );
  eq(reconnectB.ok, true, '留守者带 token 重连成功');
  eq(reconnectB.state.phase, 'won', '重连后仍是 won 视角（settleDismissed 挂在玩家对象上）');
  eq(reconnectB.state.history, settleRoom.lastGame?.history, '重连后 history 仍是快照');
  eq(reconnectB.state.result, settleRoom.lastGame?.result, '重连后 result 仍是快照');
  eq(reconnectB.state.players.map((p) => p.settleDismissed), [true, false], '重连后退出标记不变');
  eq(reconnectB.seat, 'b', '重连恢复 seat b');

  // 已退出的人离开 -> 留守者脱离假 won（OPPONENT_LEFT + aborted + 快照清空）
  const errBase = settlePlayerEvents.length;
  eq(gSettle.leaveRoom('settle-a'), { ok: true }, '退出者在对方留守时离开');
  eq(
    settlePlayerEvents
      .slice(errBase)
      .filter((e) => e.event === 'room:error' && errorOf(e).code === 'OPPONENT_LEFT')
      .map((e) => e.seat),
    ['b'],
    '留守者收到 OPPONENT_LEFT'
  );
  eq(settleRoom.lastGame, null, 'leaveRoom 清掉 lastGame');
  eq(settleRoom.players.map((p) => p.settleDismissed), [false], 'leaveRoom 复位在场玩家标记');
  eq(settleRoom.phase, 'aborted', '留守者被丢下 -> aborted（不是假 won）');
  const afterLeaveView = gSettle.getState(settleRoom, seatOf('b'));
  eq(afterLeaveView.phase, 'aborted', '留守者已脱离假 won');
  eq(afterLeaveView.history, [], '假 won 的 history 不再下发');
  gSettle.shutdown();

  // 反向：留守者自己离开，不该把已退出的人打成 aborted
  const gSettle2 = new GameModule();
  const s2Created = asOk(gSettle2.createRoom('s2-a', { name: '甲' }));
  gSettle2.joinRoom('s2-b', { code: s2Created.code, name: '乙' });
  const s2Room = gSettle2.rooms.get(s2Created.code) as Room;
  s2Room.phase = 'won';
  s2Room.result = {
    round: 1,
    words: { a: '甲', b: '甲' },
    isWin: true,
    timedOut: { a: false, b: false },
    agree: { a: false, b: false },
    winBy: 'same',
  };
  s2Room.history.push({ ...s2Room.result, basis: null } as HistoryItem);
  eq(asOk(gSettle2.restart('s2-a')).watching, true, 'A 先退出');
  eq(gSettle2.leaveRoom('s2-b'), { ok: true }, '留守者 B 离开');
  eq(s2Room.phase, 'lobby', '留守者离开不把已退出的人打成 aborted');
  eq(s2Room.lastGame, null, '留守者离开后快照作废');
  eq(s2Room.players.map((p) => p.settleDismissed), [false], '§5.3.1：leaveRoom 把在场玩家标记复位');
  eq(gSettle2.getState(s2Room, s2Room.players[0]).phase, 'lobby', 'A 仍看到真实 lobby');
  gSettle2.shutdown();

  // 全员退出 -> lastGame=null；单人房退出即刻清空
  const gSettle3 = new GameModule();
  const s3Created = asOk(gSettle3.createRoom('s3-a', { name: '甲' }));
  gSettle3.joinRoom('s3-b', { code: s3Created.code, name: '乙' });
  const s3Room = gSettle3.rooms.get(s3Created.code) as Room;
  s3Room.phase = 'won';
  s3Room.result = {
    round: 1,
    words: { a: '甲', b: '甲' },
    isWin: true,
    timedOut: { a: false, b: false },
    agree: { a: false, b: false },
    winBy: 'same',
  };
  s3Room.history.push({ ...s3Room.result, basis: null } as HistoryItem);
  eq(asOk(gSettle3.restart('s3-a')).watching, true, '第一退：watching=true');
  eq(gSettle3.restart('s3-b'), { ok: true, watching: false }, '第二退：watching=false');
  eq(s3Room.lastGame, null, '全员退出后 lastGame=null');
  eq(gSettle3.getState(s3Room, s3Room.players[0]).phase, 'lobby', '全员退出后都看真实 lobby');
  gSettle3.shutdown();

  // 新玩家加入 / _startCountdown 兜底 / sweep 删房
  const gSettle4 = new GameModule();
  const s4Created = asOk(gSettle4.createRoom('s4-a', { name: '甲' }));
  gSettle4.joinRoom('s4-b', { code: s4Created.code, name: '乙' });
  const s4Room = gSettle4.rooms.get(s4Created.code) as Room;
  s4Room.phase = 'won';
  s4Room.result = {
    round: 1,
    words: { a: '甲', b: '甲' },
    isWin: true,
    timedOut: { a: false, b: false },
    agree: { a: false, b: false },
    winBy: 'same',
  };
  s4Room.history.push({ ...s4Room.result, basis: null } as HistoryItem);
  eq(asOk(gSettle4.restart('s4-a')).watching, true, 's4：A 先退出');
  gSettle4.setReady('s4-a', true);
  gSettle4._startCountdown(s4Room);
  eq(s4Room.lastGame, null, '_startCountdown 兜底清 lastGame');
  eq(
    s4Room.players.map((p) => p.settleDismissed),
    [false, false],
    '_startCountdown 兜底复位所有 settleDismissed'
  );
  gSettle4.shutdown();

  const gSweep2 = new GameModule();
  const sweep2Created = asOk(gSweep2.createRoom('sw2-a', { name: '甲' }));
  gSweep2.joinRoom('sw2-b', { code: sweep2Created.code, name: '乙' });
  const sweep2Room = gSweep2.rooms.get(sweep2Created.code) as Room;
  sweep2Room.phase = 'won';
  sweep2Room.result = {
    round: 1,
    words: { a: '甲', b: '甲' },
    isWin: true,
    timedOut: { a: false, b: false },
    agree: { a: false, b: false },
    winBy: 'same',
  };
  sweep2Room.history.push({ ...sweep2Room.result, basis: null } as HistoryItem);
  gSweep2.restart('sw2-a');
  ok(sweep2Room.lastGame !== null, 'sweep 前存在结算快照');
  sweep2Room.players.forEach((p) => {
    p.connected = false;
    p.socketId = null;
  });
  sweep2Room.allOfflineAt = Date.now() - constants.OFFLINE_ROOM_TTL_MS - 1000;
  gSweep2.sweep();
  eq(gSweep2.roomCount(), 0, 'sweep 删除全员离线房间');
  eq(sweep2Room.lastGame, null, 'sweep 删房时一并作废快照');
  gSweep2.shutdown();

  // 新玩家加入同一房间 -> 快照作废（§5.3.1 清理路径）
  const gSettle5 = new GameModule();
  const s5Created = asOk(gSettle5.createRoom('s5-a', { name: '甲' }));
  const s5Room = gSettle5.rooms.get(s5Created.code) as Room;
  s5Room.lastGame = { round: 7, basis: null, history: [], result: null, endedAt: Date.now() };
  s5Room.phase = 'lobby';
  eq(gSettle5.getState(s5Room, s5Room.players[0]).phase, 'won', '构造：单人房里有未退出者时看到假 won');
  const s5Join = asOk(gSettle5.joinRoom('s5-b', { code: s5Created.code, name: '乙' }));
  eq(s5Join.ok, true, '新玩家加入同一房间成功');
  eq(s5Room.lastGame, null, '新玩家加入清掉 lastGame');
  eq(
    s5Room.players.map((p) => p.settleDismissed),
    [false, false],
    '新玩家加入把所有在场玩家复位'
  );
  eq(s5Join.state.phase, 'lobby', '新玩家看到真实 lobby（不是假 won）');
  eq(
    s5Join.state.players.map((p) => p.settleDismissed),
    [false, false],
    '新玩家视角 players 标记'
  );
  gSettle5.shutdown();
  pass('lastGame / settleDismissed 内部规则');
}

/* ==================== 执行 ==================== */

process.on('SIGINT', () => {
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  process.exit(130);
});

(async () => {
  let exitCode = 0;
  try {
    await main();
    console.log(`\n✅ 测试通过：共 ${checkCount} 项断言`);
  } catch (err) {
    exitCode = 1;
    console.error(`\n❌ 测试失败：${err instanceof Error && err.stack ? err.stack : err}`);
    const logs = childLogs();
    if (logs) {
      console.error('\n--- server stdout ---\n' + logs.out);
      console.error('\n--- server stderr ---\n' + logs.err);
    }
  } finally {
    for (const client of clients) client.disconnect();
    await stopServer();
    process.exit(exitCode);
  }
})();
