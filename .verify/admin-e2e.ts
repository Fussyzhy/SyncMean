/**
 * 管理后台真浏览器验收（v3.5 / PROTOCOL.md §14.5 第 16 条，Edge headless + CDP）
 *
 * 运行方式（推荐先用 yarn build 产出最新前端）：
 *   APP_URL=http://127.0.0.1:3311 yarn verify:admin
 *
 * 职责：
 * - 若 APP_URL 上已有服务在跑（外部启动的 3311），直接复用、不负责关闭；
 * - 若没有服务在跑，则自己用 `node dist/server/index.js` 在 APP_URL 端口启动一个
 *   （ADMIN_KEY 取进程环境变量，缺失时取项目根 .env），结束后 try/finally 杀掉；
 * - 用 Edge headless + CDP 打开 /admin，走完 门禁 → 错误密钥 → 正确密钥 → 房间列表 →
 *   观战 → 二次确认终止房间 → 刷新保持登录 → 退出登录 全流程；
 * - 全程零第三方依赖：浏览器控制用 Node 22 内置 WebSocket 直连 CDP，
 *   建房用项目已有的 socket.io-client。
 *
 * 断言失败会汇总打印并 exit 1；截图落在 .verify/shots/admin-*.png。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io, type Socket } from 'socket.io-client';

import type {
  ClientToServerEvents,
  CreateOk,
  CreatePayload,
  ActionResult,
  ServerToClientEvents,
} from '../src/shared/protocol.js';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const EDGE =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const OUT = path.join(HERE, 'shots');
const SERVER_START_TIMEOUT_MS = 20000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args: unknown[]): void => console.log(...args);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 管理密钥：进程环境变量优先（env.ts 的 ADMIN_KEY 导出已实现「进程 > .env」） */
async function resolveAdminKey(): Promise<string> {
  if (process.env.ADMIN_KEY && process.env.ADMIN_KEY.trim()) return process.env.ADMIN_KEY.trim();
  // 动态 import：只有缺少进程环境变量时才触发 .env 加载；解析结果即「进程 > .env」
  const env = (await import('../src/server/env.js')) as { ADMIN_KEY: string };
  return (env.ADMIN_KEY || '').trim();
}

/* ------------------------------------------------------------------ */
/* CDP 最小封装（与 .verify/ui-e2e.ts 同源，这里只保留本脚本需要的能力）  */
/* ------------------------------------------------------------------ */

interface CdpError {
  code: number;
  message: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpError;
  sessionId?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type AnyEventListener = (params: unknown, sessionId: string | undefined) => void;

interface DevToolsVersionInfo {
  webSocketDebuggerUrl: string;
  browser?: string;
  protocolVersion?: string;
}

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface CaptureScreenshotResult {
  data?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function parseVersionInfo(value: unknown): DevToolsVersionInfo | null {
  const r = asRecord(value);
  if (typeof r.webSocketDebuggerUrl !== 'string') return null;
  return {
    webSocketDebuggerUrl: r.webSocketDebuggerUrl,
    browser: typeof r.Browser === 'string' ? r.Browser : undefined,
    protocolVersion: typeof r['Protocol-Version'] === 'string' ? r['Protocol-Version'] : undefined,
  };
}

class Browser {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, AnyEventListener[]>();
  readonly browserVersion: string;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly profile: string,
    private readonly ws: WebSocket,
    info: DevToolsVersionInfo
  ) {
    this.browserVersion = info.browser ?? 'unknown';
  }

  static async launch(): Promise<Browser> {
    if (!fs.existsSync(EDGE)) {
      throw new Error(`找不到 Edge：${EDGE}（可用 EDGE_PATH 覆盖）`);
    }
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-e2e-edge-'));
    const proc = spawn(
      EDGE,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--hide-scrollbars',
        '--mute-audio',
        '--window-size=430,932',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    let info: DevToolsVersionInfo | null = null;
    for (let i = 0; i < 120; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        info = parseVersionInfo(await res.json());
        if (info) break;
      } catch {
        // CDP 端口尚未就绪，继续轮询
      }
      await sleep(150);
    }
    if (!info) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      throw new Error('浏览器未能启动（CDP 端口无响应）');
    }

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
        once: true,
      });
    });

    const browser = new Browser(proc, profile, ws, info);
    ws.addEventListener('message', (ev) => {
      try {
        browser.handleMessage(JSON.parse(String(ev.data)) as CdpMessage);
      } catch {
        // 忽略无法解析的消息
      }
    });
    log(`  🧭 Edge ${browser.browserVersion} / CDP 端口 ${CDP_PORT}`);
    return browser;
  }

  private handleMessage(msg: CdpMessage): void {
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else pending.resolve(msg.result);
        return;
      }
    }
    if (typeof msg.method === 'string') {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    }
  }

  on(method: string, fn: AnyEventListener): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    const id = (this.nextId += 1);
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ws.send(JSON.stringify(payload));
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
      timer.unref();
    });
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(this, sessionId, targetId);
    await page.init();
    return page;
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    await sleep(300);
    try {
      fs.rmSync(this.profile, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

class Page {
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  /** console 错误的原始条目（带发生时刻与资源 URL，便于区分「预期内的握手 400」） */
  readonly consoleErrorEntries: { text: string; url: string; at: number }[] = [];
  /** 浏览器网络层失败请求（status ≥ 400），用于定位「错误密钥被拒」等预期网络日志的具体 URL */
  readonly failedRequests: { url: string; status: number; method: string; at: number }[] = [];

  constructor(
    private readonly browser: Browser,
    readonly sessionId: string,
    readonly targetId: string
  ) {}

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async init(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    this.browser.on('Network.responseReceived', (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      const p = params as {
        response?: { url?: string; status?: number };
        type?: string;
      };
      const status = p.response?.status ?? 0;
      if (status < 400) return;
      this.failedRequests.push({
        url: p.response?.url ?? '',
        status,
        method: p.type ?? '',
        at: Date.now(),
      });
    });
    this.browser.on('Runtime.consoleAPICalled', (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      const p = params as { type?: string; args?: { value?: unknown; description?: string }[] };
      if (p.type !== 'error') return;
      const text = (p.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' ');
      this.consoleErrors.push(text);
      this.consoleErrorEntries.push({ text, url: '', at: Date.now() });
    });
    this.browser.on('Runtime.exceptionThrown', (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      const p = params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      this.pageErrors.push(
        p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown'
      );
    });
    this.browser.on('Log.entryAdded', (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      const p = params as {
        entry?: { level?: string; text?: string; url?: string };
      };
      if (p.entry?.level !== 'error') return;
      const text = p.entry.text || '';
      const url = typeof p.entry.url === 'string' ? p.entry.url : '';
      this.consoleErrors.push(text);
      this.consoleErrorEntries.push({ text, url, at: Date.now() });
    });
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: 430,
      screenHeight: 932,
    });
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 20000, `页面加载 ${url}`);
    await sleep(300);
  }

  async reload(): Promise<void> {
    await this.send('Page.reload', { ignoreCache: false });
    await this.waitFor('document.readyState === "complete"', 20000, '页面刷新');
    await sleep(300);
  }

  async eval(expression: string): Promise<unknown> {
    const r = await this.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        '页面脚本异常: ' +
          String(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      );
    }
    return r.result?.value;
  }

  async waitFor(expression: string, timeout = 15000, label = expression): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await this.eval(expression)) return true;
      } catch {
        // 页面可能正在导航
      }
      await sleep(120);
    }
    throw new Error(`等待超时: ${label}`);
  }

  async click(selector: string): Promise<void> {
    const clicked = Boolean(
      await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`)
    );
    if (!clicked) throw new Error(`找不到可点击元素: ${selector}`);
  }

  async type(selector: string, text: string): Promise<void> {
    const typed = Boolean(
      await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
    );
    if (!typed) throw new Error(`找不到输入框: ${selector}`);
  }

  async text(selector: string): Promise<string | null> {
    const value = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? (el.innerText || el.textContent || '').trim() : null;
    })()`);
    return typeof value === 'string' ? value : null;
  }

  async isVisible(selector: string): Promise<boolean> {
    return Boolean(
      await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (getComputedStyle(el).visibility === 'hidden') return false;
        let node = el.parentElement;
        while (node && node !== document.body) {
          const cs = getComputedStyle(node);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          node = node.parentElement;
        }
        return true;
      })()`)
    );
  }

  async screenshot(name: string): Promise<string | null> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const r = await this.send<CaptureScreenshotResult>('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        if (!r || !r.data) throw new Error('无 data');
        const file = path.join(OUT, name);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        log(`  📸 ${name}`);
        return file;
      } catch (err) {
        if (attempt === 1) {
          log(`  ⚠️ 截图 ${name} 失败（${errorMessage(err)}），重试一次…`);
          await sleep(1200);
        } else {
          log(`  ⚠️ 截图 ${name} 跳过（${errorMessage(err)}）——不影响功能断言`);
        }
      }
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 断言与流程                                                          */
/* ------------------------------------------------------------------ */

const problems: string[] = [];
const shots: string[] = [];

function check(condition: unknown, message: string): void {
  if (condition) {
    log(`  ✅ ${message}`);
  } else {
    problems.push(message);
    log(`  ❌ ${message}`);
  }
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(same, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

/* ---------------- 被验收服务 ---------------- */

interface ManagedServer {
  proc: ChildProcess | null;
  base: string;
}

async function probeHealth(base: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * APP_URL 上已有服务就复用（外部启动，不负责关闭）；否则自己启动一个。
 * 自己启动时把 ADMIN_KEY 传进进程环境变量（进程环境 > .env）。
 */
async function ensureServer(adminKey: string): Promise<ManagedServer> {
  if (await probeHealth(APP_URL)) {
    log(`  ♻️ 复用已在运行的服务 ${APP_URL}（脚本不负责关闭它）`);
    return { proc: null, base: APP_URL };
  }
  const entry = path.join(ROOT, 'dist', 'server', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`没有找到 ${entry}，请先执行 yarn build`);
  }
  const port = Number(new URL(APP_URL).port || '80');
  const proc = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_KEY: adminKey },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = { out: '', err: '' };
  proc.stdout?.on('data', (chunk: Buffer) => {
    logs.out += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    logs.err += chunk.toString();
  });

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `验收服务提前退出（code=${proc.exitCode}）\nstdout:\n${logs.out}\nstderr:\n${logs.err}`
      );
    }
    if (await probeHealth(APP_URL)) {
      log(`  🚀 已启动验收服务 ${APP_URL}（PID=${proc.pid}，ADMIN_KEY 已注入）`);
      return { proc, base: APP_URL };
    }
    await sleep(150);
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
  throw new Error(
    `验收服务 ${SERVER_START_TIMEOUT_MS}ms 内未就绪\nstdout:\n${logs.out}\nstderr:\n${logs.err}`
  );
}

async function stopServer(server: ManagedServer): Promise<void> {
  if (!server.proc || server.proc.exitCode !== null) return;
  const proc = server.proc;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
  await Promise.race([exited, sleep(3000)]);
  log('  🧹 已关闭验收服务进程');
}

/* ---------------- 假玩家（socket.io-client，仅用于建房） ---------------- */

interface PlayerClient {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  log: { event: string; payload: unknown; at: number }[];
  disconnect(): void;
}

function connectPlayer(): Promise<PlayerClient> {
  const socket = io(APP_URL, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 8000,
  }) as Socket<ServerToClientEvents, ClientToServerEvents>;
  const client: PlayerClient = {
    socket,
    log: [],
    disconnect() {
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
    },
  };
  socket.onAny((event: string, ...args: unknown[]) => {
    client.log.push({ event, payload: args.length <= 1 ? args[0] : args, at: Date.now() });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('假玩家连接超时')), 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`假玩家连接失败：${err.message}`));
    });
  });
}

function playerEmitAck(
  client: PlayerClient,
  event: 'room:create',
  payload: CreatePayload
): Promise<ActionResult<CreateOk>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${event} 在 8000ms 内没有收到 ack`));
    }, 8000);
    (client.socket.emit as unknown as (
      ev: string,
      data: unknown,
      ack: (res: unknown) => void
    ) => boolean)(event, payload, (res: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res as ActionResult<CreateOk>);
    });
  });
}

interface WaitPlayerEventOptions {
  since?: number;
  timeout?: number;
  hint?: string;
}

/** 在假玩家 log[since..] 里等一个满足 predicate 的玩家事件 */
async function waitPlayerEvent(
  client: PlayerClient,
  event: 'room:error',
  predicate: (payload: { code?: string; message?: string }) => boolean,
  options: WaitPlayerEventOptions = {}
): Promise<{ code?: string; message?: string }> {
  const { since = 0, timeout = 5000, hint } = options;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (let i = since; i < client.log.length; i += 1) {
      const entry = client.log[i];
      if (
        entry.event === event &&
        predicate(entry.payload as { code?: string; message?: string })
      ) {
        return entry.payload as { code?: string; message?: string };
      }
    }
    await sleep(20);
  }
  throw new Error(`假玩家在 ${timeout}ms 内未等到 ${event}${hint ? `（${hint}）` : ''}`);
}

/* ---------------- 主流程 ---------------- */

async function run(page: Page, adminKey: string): Promise<void> {
  const ADMIN_KEY_INPUT = JSON.stringify(adminKey);
  const WRONG_KEY = 'definitely-not-the-admin-key';

  log('\n[1] 打开 /admin：只显示密钥门禁');
  await page.goto(`${APP_URL}/admin`);
  check(await page.isVisible('#view-admin'), '/admin 渲染出管理后台根容器 #view-admin');
  check(
    String(await page.eval('document.body.dataset.view')) === 'admin',
    '<body data-view="admin"> 已设置'
  );
  check(
    String(await page.eval('document.title')).includes('管理后台'),
    `页面标题为管理后台（"${String(await page.eval('document.title'))}"）`
  );
  check(await page.isVisible('#admin-gate'), '未登录时 #admin-gate 可见');
  check(!(await page.isVisible('#admin-dashboard')), '未登录时 #admin-dashboard 不存在/不可见');
  const gateShot = await page.screenshot('admin-gate.png');
  if (gateShot) shots.push(gateShot);

  log('\n[2] 错误密钥：显示错误且仍停留在门禁');
  // 记下错误密钥窗口：socket.io 在 polling 握手被 namespace 中间件拒绝时会返回 HTTP 400，
  // 浏览器控制台必然记一条 "Failed to load resource ... 400"，这是负向用例的预期网络日志，
  // 不应算作应用 console 报错（最终检查里按「窗口 + /socket.io/ + 400」精确放行）。
  const authProbeStart = Date.now();
  await page.type('#admin-key-input', WRONG_KEY);
  await page.click('#btn-admin-login');
  await page.waitFor(
    '(() => { const el = document.querySelector("#admin-gate-error"); return !!el && (el.innerText || "").trim().length > 0; })()',
    10000,
    '#admin-gate-error 出现错误文案'
  );
  const authProbeEnd = Date.now();
  const gateError = (await page.text('#admin-gate-error')) || '';
  check(gateError.length > 0, `#admin-gate-error 非空（"${gateError}"）`);
  check(gateError.includes('密钥'), '错误文案提示密钥问题');
  check(await page.isVisible('#admin-gate'), '错误密钥后仍在门禁');
  check(!(await page.isVisible('#admin-dashboard')), '错误密钥后不显示面板');

  log('\n[3] 正确密钥：进入面板并显示连接状态');
  await page.type('#admin-key-input', adminKey);
  await page.click('#btn-admin-login');
  await page.waitFor('!!document.querySelector("#admin-dashboard")', 15000, '#admin-dashboard 出现');
  await page.waitFor(
    '(() => { const el = document.querySelector("#admin-status"); return !!el && (el.innerText || "").includes("已连接"); })()',
    15000,
    '#admin-status 显示已连接'
  );
  check(await page.isVisible('#admin-dashboard'), '#admin-dashboard 可见');
  check(!(await page.isVisible('#admin-gate')), '登录后 #admin-gate 不再显示');
  check(
    (await page.text('#admin-status'))?.includes('已连接') === true,
    '#admin-status 文案为已连接'
  );

  // §14.1：密钥只允许存在 sessionStorage，禁止 localStorage / URL / DOM / 日志。
  // 注意：**不要把密钥值写进断言文案 / 日志**（下方只断言是否相等，不打印明文）。
  const storage = asRecord(
    await page.eval(`(() => ({
      session: (() => { try { return sessionStorage.getItem('321:admin-key'); } catch (e) { return null; } })(),
      local: (() => { try { return localStorage.getItem('321:admin-key'); } catch (e) { return null; } })(),
      body: document.body.innerHTML,
      url: location.href,
    }))()`)
  );
  check(storage.session === adminKey, '密钥保存在 sessionStorage["321:admin-key"]');
  check(storage.local === null, '密钥没有写 localStorage');
  check(!String(storage.url).includes(adminKey), '密钥没有出现在 URL 里');
  check(!String(storage.body).includes(adminKey), '密钥没有出现在 DOM HTML 里');

  await page.waitFor('!!document.querySelector("#admin-empty")', 8000, '空列表占位 #admin-empty');
  check(await page.isVisible('#admin-empty'), '没有房间时显示 #admin-empty');

  log('\n[4] 用假玩家建房：房间实时出现在列表');
  const player = await connectPlayer();
  const uniqueSuffix = String(Date.now()).slice(-4);
  const playerName = `验收${uniqueSuffix}`;
  const created = await playerEmitAck(player, 'room:create', { name: playerName });
  if (created.ok !== true) throw new Error(`建房失败：${JSON.stringify(created)}`);
  const roomCode = created.code;
  log(`  房间 ${roomCode} / 房主 ${playerName}`);
  const cardSelector = `.admin-room-card[data-code="${roomCode}"]`;
  const watchSelector = `.btn-admin-watch[data-code="${roomCode}"]`;
  await page.waitFor(
    `!!document.querySelector(${JSON.stringify(cardSelector)})`,
    8000,
    `房间 ${roomCode} 出现在列表`
  );
  check(
    ((await page.text(cardSelector)) || '').includes(roomCode),
    `列表卡片展示房间码 ${roomCode}`
  );
  check(
    ((await page.text(cardSelector)) || '').includes(playerName),
    `列表卡片展示房主昵称 ${playerName}`
  );
  check(!(await page.isVisible('#admin-empty')), '有房间后 #admin-empty 消失');
  check(
    Number((await page.text('#admin-room-count')) || '0') >= 1,
    '#admin-room-count 至少为 1'
  );
  const listShot = await page.screenshot('admin-list.png');
  if (listShot) shots.push(listShot);

  log('\n[5] 点「观战」：进入实时详情');
  await page.click(watchSelector);
  await page.waitFor('!!document.querySelector("#admin-room-detail")', 10000, '#admin-room-detail 出现');
  await page.waitFor(
    `(() => { const el = document.querySelector("#admin-detail-code"); return !!el && (el.innerText || "").trim() === ${JSON.stringify(roomCode)}; })()`,
    8000,
    `#admin-detail-code 文本 = ${roomCode}`
  );
  check(await page.isVisible('#admin-room-detail'), '#admin-room-detail 可见');
  eq((await page.text('#admin-detail-code'))?.trim(), roomCode, '#admin-detail-code 文本 = 房间码');
  check(
    ((await page.text('#admin-room-detail')) || '').includes(playerName),
    '观战详情展示房主昵称（命中真实房间数据）'
  );
  const detailShot = await page.screenshot('admin-detail.png');
  if (detailShot) shots.push(detailShot);

  log('\n[6] 「终止房间」二次确认：房间消失、观战面板显示已关闭、玩家收到 ROOM_DELETED');
  const delMark = player.log.length;
  const deleteSelector = `#admin-room-detail .btn-admin-delete[data-code="${roomCode}"]`;
  await page.click(deleteSelector);
  await page.waitFor(
    `(() => { const el = document.querySelector(${JSON.stringify(deleteSelector)}); return !!el && (el.innerText || "").includes("确认终止？"); })()`,
    4000,
    '第一次点击后按钮文案变为「确认终止？」'
  );
  check(true, '第一次点击「终止房间」进入二次确认（文案「确认终止？」）');
  await page.click(deleteSelector);
  await page.waitFor(
    `!document.querySelector(${JSON.stringify(cardSelector)})`,
    8000,
    `房间 ${roomCode} 从列表消失`
  );
  check(true, `二次确认后房间 ${roomCode} 从列表消失`);
  await page.waitFor('!!document.querySelector("#admin-room-closed")', 8000, '#admin-room-closed 出现');
  check(await page.isVisible('#admin-room-closed'), '观战面板出现 #admin-room-closed');
  await page.waitFor(
    '(() => { const el = document.querySelector("#admin-room-count"); return !!el && (el.innerText || "").trim() === "0"; })()',
    8000,
    '#admin-room-count 变为 0'
  );
  eq((await page.text('#admin-room-count'))?.trim(), '0', '#admin-room-count 变为 0');
  const playerError = await waitPlayerEvent(
    player,
    'room:error',
    (payload) => payload.code === 'ROOM_DELETED',
    { since: delMark, timeout: 5000, hint: '玩家收到 ROOM_DELETED' }
  );
  eq(playerError.code, 'ROOM_DELETED', '假玩家收到 room:error code=ROOM_DELETED');
  const closedShot = await page.screenshot('admin-closed.png');
  if (closedShot) shots.push(closedShot);

  log('\n[7] 刷新页面：sessionStorage 保留密钥，自动回到面板');
  await page.reload();
  await page.waitFor('!!document.querySelector("#admin-dashboard")', 15000, '刷新后 #admin-dashboard 出现');
  check(await page.isVisible('#admin-dashboard'), '刷新后仍停留在 #admin-dashboard');
  check(!(await page.isVisible('#admin-gate')), '刷新后不回到门禁');
  const sessionAfterReload = await page.eval(
    `(() => { try { return sessionStorage.getItem('321:admin-key'); } catch (e) { return null; } })()`
  );
  check(sessionAfterReload === adminKey, '刷新后 sessionStorage 仍保留密钥（值不打印）');
  const reloadShot = await page.screenshot('admin-dashboard-reload.png');
  if (reloadShot) shots.push(reloadShot);

  log('\n[8] 退出登录：清 sessionStorage 并回到门禁');
  await page.click('#btn-admin-logout');
  await page.waitFor('!!document.querySelector("#admin-gate")', 8000, '退出登录后回到 #admin-gate');
  check(await page.isVisible('#admin-gate'), '退出登录后显示 #admin-gate');
  check(!(await page.isVisible('#admin-dashboard')), '退出登录后面板消失');
  const sessionAfterLogout = await page.eval(
    `(() => { try { return sessionStorage.getItem('321:admin-key'); } catch (e) { return null; } })()`
  );
  eq(sessionAfterLogout, null, '退出登录后 sessionStorage 密钥被清除');

  log('\n[9] 控制台 / 网络失败请求 / 未捕获异常检查');
  // 网络层：错误密钥被 socket.io 握手拒绝时允许出现 1 条 /socket.io/ 的 400（负向用例的预期结果）
  const failedRequests = page.failedRequests.filter((req) => !/favicon/i.test(req.url));
  const expectedAuthNetwork = failedRequests.filter(
    (req) =>
      req.status === 400 &&
      req.url.includes('/socket.io/') &&
      req.at >= authProbeStart &&
      req.at <= authProbeEnd + 8000
  );
  const unexpectedRequests = failedRequests.filter((req) => !expectedAuthNetwork.includes(req));
  check(
    expectedAuthNetwork.length <= 2,
    `错误密钥被拒只产生 ≤2 条预期的 /socket.io/ 握手 400（实际 ${expectedAuthNetwork.length} 条）`
  );
  for (const req of expectedAuthNetwork) {
    log(`      · 预期握手失败: HTTP ${req.status} ${req.url}`);
  }
  check(
    unexpectedRequests.length === 0,
    `无意外的失败网络请求（${unexpectedRequests.length} 条）`
  );
  for (const req of unexpectedRequests.slice(0, 10)) {
    log(`      · HTTP ${req.status} ${req.url}`);
  }

  const authProbeExpected = page.consoleErrorEntries.filter(
    (entry) =>
      entry.at >= authProbeStart &&
      entry.at <= authProbeEnd + 8000 &&
      /Failed to load resource/.test(entry.text) &&
      /400/.test(entry.text) &&
      (entry.url === '' || entry.url.includes('/socket.io/'))
  );
  const unexpectedConsole = page.consoleErrorEntries.filter(
    (entry) => !authProbeExpected.includes(entry) && !/favicon/i.test(entry.text)
  );
  check(
    authProbeExpected.length <= 2,
    `错误密钥被拒只产生 ≤2 条预期的 socket.io 400 网络日志（实际 ${authProbeExpected.length} 条）`
  );
  for (const entry of authProbeExpected) {
    log(`      · 预期网络日志: ${entry.text}${entry.url ? ' @ ' + entry.url : ''}`);
  }
  check(
    unexpectedConsole.length === 0,
    `管理后台页面无其他 console error（${unexpectedConsole.length} 条；预期网络 400 共 ${authProbeExpected.length} 条）`
  );
  for (const entry of unexpectedConsole.slice(0, 10)) {
    log(`      · ${entry.text}${entry.url ? ' @ ' + entry.url : ''}`);
  }
  check(page.pageErrors.length === 0, `页面无未捕获异常（${page.pageErrors.length} 条）`);
  for (const text of page.pageErrors.slice(0, 10)) log(`      · ${text}`);
  player.disconnect();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const adminKey = await resolveAdminKey();
  if (!adminKey) {
    throw new Error(
      '缺少 ADMIN_KEY：请在进程环境变量或项目根 .env 里配置后再运行（缺失时管理后台会被服务端禁用）'
    );
  }
  if (adminKey === `change-me`) {
    throw new Error('ADMIN_KEY 仍是模板占位值，请先改成真实密钥');
  }
  log(`目标地址：${APP_URL}`);
  log(`管理密钥：已配置（长度 ${adminKey.length}，不打印明文）`);

  let server: ManagedServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await ensureServer(adminKey);
    browser = await Browser.launch();
    const page = await browser.newPage();
    await run(page, adminKey);
    log(`\n截图: ${shots.join(', ')}`);
    if (problems.length > 0) {
      console.error(`\n❌ 失败 ${problems.length} 项：`);
      for (const problem of problems) console.error(`   - ${problem}`);
      process.exitCode = 1;
    } else {
      log('\n✅ 管理后台真浏览器验收全部通过');
    }
  } catch (err) {
    console.error(`\n💥 流程中断：${errorMessage(err)}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server);
  }
}

await main();
