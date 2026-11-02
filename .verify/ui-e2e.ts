/**
 * 真实浏览器端到端验收（Edge headless + CDP，无需额外依赖）
 *   npx tsx .verify/ui-e2e.ts          # 跑完整双人对局流程（含同意词投票、结算导出、准备按钮 loading 回归）
 *   npx tsx .verify/ui-e2e.ts --smoke  # 仅验证 CDP 工具链可用
 * 前置：服务已在 http://127.0.0.1:3210 运行。
 *
 * 迁移说明：本文件由 .verify/ui-e2e.js（只读蓝本）1:1 迁移为 TypeScript，
 * 保留全部 63 条对局 check（+ --smoke 1 条），未放宽任何断言；DOM id 与 PROTOCOL.md §9 一致。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM 下没有 __dirname，用 import.meta.url 还原脚本目录
const HERE = path.dirname(fileURLToPath(import.meta.url));

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3210';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const OUT = path.join(HERE, 'shots');
const SMOKE = process.argv.includes('--smoke');
// PROTOCOL.md §3：揭晓停留 4.5s 后自动进下一轮，用于验证「投票后冻结」
const REVEAL_MS = 4500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...a: unknown[]): void => console.log(...a);
const shots: string[] = [];

/* ------------------------------------------------------------------ */
/* 自有最小类型：CDP 协议消息（不引入 puppeteer / playwright 等依赖）      */
/* ------------------------------------------------------------------ */

interface CdpError {
  code: number;
  message: string;
}

/** CDP 线上消息：请求 / 响应共用同一信封（id 对应请求，method+params 为事件） */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpError;
  sessionId?: string;
}

interface CdpRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type AnyEventListener = (params: unknown, sessionId: string | undefined) => void;

/** 页面 console 参数（Runtime.consoleAPICalled） */
interface ConsoleApiArg {
  value?: unknown;
  description?: string;
}

interface RuntimeConsoleAPICalledParams {
  type?: string;
  args?: ConsoleApiArg[];
}

interface ExceptionThrownParams {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

interface LogEntryAddedParams {
  entry?: { level?: string; text?: string };
}

/** 本脚本用到的事件集合，保证 on() / handler 参数按事件收窄 */
interface CdpEventMap {
  'Runtime.consoleAPICalled': RuntimeConsoleAPICalledParams;
  'Runtime.exceptionThrown': ExceptionThrownParams;
  'Log.entryAdded': LogEntryAddedParams;
}

/** /json/version 的响应（只取本脚本需要的字段） */
interface DevToolsVersionInfo {
  webSocketDebuggerUrl: string;
  browser?: string;
  protocolVersion?: string;
}

interface RemoteObject {
  value?: unknown;
}

interface ExceptionDetails {
  text?: string;
  exception?: { description?: string };
}

interface EvaluateResult {
  result?: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

interface CaptureScreenshotResult {
  data?: string;
}

/* ------------------------------------------------------------------ */
/* 页面求值结果的最小类型守卫（页面脚本返回值是 unknown，逐处收窄）        */
/* ------------------------------------------------------------------ */

interface BusyState {
  exists: true;
  text: string;
  isBusy: boolean;
  ariaBusy: string | null;
  colorTransparent: boolean;
  disabled: boolean;
}

interface DownloadInfo {
  clicked: number;
  name: string;
  bytes: number;
  isPng: boolean;
  w: number;
  h: number;
  b64?: string;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** /json/version 的键名是 CDP 风格的 `Browser` / `Protocol-Version`（也兼容 snake/camel 写法） */
function readStringField(r: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = r[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function parseVersionInfo(value: unknown): DevToolsVersionInfo | null {
  const r = asRecord(value);
  if (typeof r.webSocketDebuggerUrl !== 'string') return null;
  return {
    webSocketDebuggerUrl: r.webSocketDebuggerUrl,
    browser: readStringField(r, 'Browser', 'browser'),
    protocolVersion: readStringField(r, 'Protocol-Version', 'protocolVersion'),
  };
}

function toBusyState(value: unknown): BusyState | null {
  const r = asRecord(value);
  if (
    r.exists !== true ||
    typeof r.text !== 'string' ||
    typeof r.isBusy !== 'boolean' ||
    typeof r.colorTransparent !== 'boolean' ||
    typeof r.disabled !== 'boolean'
  ) {
    return null;
  }
  const ariaBusy =
    typeof r.ariaBusy === 'string'
      ? r.ariaBusy
      : r.ariaBusy === null || r.ariaBusy === undefined
        ? null
        : String(r.ariaBusy);
  return {
    exists: true,
    text: r.text,
    isBusy: r.isBusy,
    ariaBusy,
    colorTransparent: r.colorTransparent,
    disabled: r.disabled,
  };
}

function toDownloadInfo(value: unknown): DownloadInfo {
  const r = asRecord(value);
  return {
    clicked: typeof r.clicked === 'number' ? r.clicked : 0,
    name: typeof r.name === 'string' ? r.name : '',
    bytes: typeof r.bytes === 'number' ? r.bytes : 0,
    isPng: r.isPng === true,
    w: typeof r.w === 'number' ? r.w : 0,
    h: typeof r.h === 'number' ? r.h : 0,
    b64: typeof r.b64 === 'string' ? r.b64 : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Browser：启动 Edge、轮询 CDP、WebSocket 消息分发与请求超时             */
/* ------------------------------------------------------------------ */

class Browser {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, AnyEventListener[]>();
  readonly browserVersion: string;
  readonly protocolVersion: string;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly profile: string,
    private readonly ws: WebSocket,
    info: DevToolsVersionInfo,
  ) {
    this.browserVersion = info.browser ?? 'unknown';
    this.protocolVersion = info.protocolVersion ?? 'unknown';
  }

  static async launch(): Promise<Browser> {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'w321-edge-'));
    const proc = spawn(EDGE, [
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
    ], { stdio: 'ignore' });

    let info: DevToolsVersionInfo | null = null;
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        info = parseVersionInfo(await r.json());
        if (info) break;
      } catch {
        // CDP 端口尚未就绪，继续轮询
      }
      await sleep(150);
    }
    if (!info) {
      proc.kill();
      throw new Error('浏览器未能启动（CDP 端口无响应）');
    }

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });

    const browser = new Browser(proc, profile, ws, info);
    ws.addEventListener('message', (ev) => {
      try {
        browser.handleMessage(JSON.parse(String(ev.data)) as CdpMessage);
      } catch {
        // 忽略无法解析的消息
      }
    });
    log(`  🧭 Edge ${browser.browserVersion} / CDP ${browser.protocolVersion}`);
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
      const fns = this.listeners.get(msg.method) ?? [];
      for (const fn of fns) fn(msg.params, msg.sessionId);
    }
  }

  on<K extends keyof CdpEventMap>(method: K, fn: (params: CdpEventMap[K], sessionId: string | undefined) => void): void {
    const fns = this.listeners.get(method) ?? [];
    fns.push((params, sessionId) => fn(params as CdpEventMap[K], sessionId));
    this.listeners.set(method, fns);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    const payload: CdpRequest = { id, method, params };
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
      // 仅超时兜底用，不应让进程为了等它而多活 30s
      timer.unref();
    });
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init();
    return page;
  }

  async close(): Promise<void> {
    try { this.ws.close(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Page：单标签页（CDP session）上的导航、求值、等待与交互辅助           */
/* ------------------------------------------------------------------ */

class Page {
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];

  constructor(
    private readonly b: Browser,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.b.send<T>(method, params, this.sessionId);
  }

  async init(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    this.b.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== this.sessionId) return;
      if (p.type === 'error') {
        this.consoleErrors.push((p.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' '));
      }
    });
    this.b.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid !== this.sessionId) return;
      this.pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
    });
    this.b.on('Log.entryAdded', (p, sid) => {
      if (sid !== this.sessionId) return;
      if (p.entry?.level === 'error') this.consoleErrors.push(p.entry.text || '');
    });
    await this.setViewport(430, 932);
  }

  async setViewport(width: number, height: number, mobile = true): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile,
      screenWidth: width, screenHeight: height,
    });
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 20000, '页面加载');
    await sleep(400);
  }

  /** 在页面里求值；页面脚本异常直接抛出（与旧脚本一致） */
  async eval(expression: string): Promise<unknown> {
    const r = await this.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async waitFor(expression: string, timeout = 15000, label = expression): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await this.eval(expression)) return true;
      } catch { /* 页面可能正在跳转 */ }
      await sleep(120);
    }
    throw new Error(`等待超时: ${label}`);
  }

  async click(selector: string): Promise<void> {
    const ok = Boolean(await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`));
    if (!ok) throw new Error(`找不到可点击元素: ${selector}`);
  }

  async type(selector: string, text: string): Promise<void> {
    const ok = Boolean(await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
    if (!ok) throw new Error(`找不到输入框: ${selector}`);
  }

  async text(selector: string): Promise<string | null> {
    const value = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.innerText.trim() : null;
    })()`);
    return typeof value === 'string' ? value : null;
  }

  async bodyText(): Promise<string> {
    const value = await this.eval('document.body ? document.body.innerText : ""');
    return typeof value === 'string' ? value : '';
  }

  /** 元素在视口内可见且未被禁用 */
  async readyToType(selector: string): Promise<boolean> {
    return Boolean(await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    })()`));
  }

  /** 元素视觉可见（有尺寸、未被 display:none / visibility:hidden 隐藏）。只看渲染事实，不看 aria-hidden。 */
  async isVisible(selector: string): Promise<boolean> {
    return Boolean(await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
      if (getComputedStyle(el).visibility === 'hidden') return false;
      let node = el.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      return true;
    })()`));
  }

  /** 按钮是否残留 loading 态（bug 回归用） */
  async busyState(selector: string): Promise<BusyState | null> {
    return toBusyState(await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        exists: true,
        text: (el.textContent || '').trim(),
        isBusy: el.classList.contains('is-busy'),
        ariaBusy: el.getAttribute('aria-busy'),
        colorTransparent: /rgba?\\(\\s*0,\\s*0,\\s*0,\\s*0\\s*\\)|transparent/i.test(cs.color),
        disabled: !!el.disabled
      };
    })()`));
  }

  /**
   * 拦截导出下载：包裹 HTMLAnchorElement.prototype.click 与 a.download 路径，
   * 再把拿到的 href（blob: 或 data:）解析成真实字节，返回 PNG 头与尺寸。
   */
  async armDownloadHook(): Promise<boolean> {
    return Boolean(await this.eval(`(() => {
      window.__dl = { clicked: 0, href: '', name: '', error: '' };
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        try {
          if (this.hasAttribute('download') || this.download) {
            window.__dl.clicked += 1;
            window.__dl.href = this.href || '';
            window.__dl.name = this.download || this.getAttribute('download') || '';
            return; // 吃掉真实下载，避免 headless 里弹下载条
          }
        } catch (e) { window.__dl.error = String((e && e.message) || e); }
        return orig.apply(this, arguments);
      };
      return true;
    })()`));
  }

  async readDownload(): Promise<DownloadInfo> {
    return toDownloadInfo(await this.eval(`(async () => {
      const d = window.__dl || { clicked: 0, href: '', name: '' };
      if (!d.clicked || !d.href) return { clicked: d.clicked || 0, name: d.name || '', bytes: 0, isPng: false, w: 0, h: 0 };
      let buf;
      try {
        if (d.href.startsWith('data:')) {
          const base64 = d.href.split(',')[1] || '';
          const bin = atob(base64);
          buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        } else {
          const blob = await (await fetch(d.href)).blob();
          buf = new Uint8Array(await blob.arrayBuffer());
        }
      } catch (e) {
        return { clicked: d.clicked, name: d.name, bytes: 0, isPng: false, w: 0, h: 0, error: String(e && e.message || e) };
      }
      const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      let w = 0, h = 0;
      if (isPng) { w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19]; h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23]; }
      let b64 = '';
      try {
        let s = '';
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        b64 = btoa(s);
      } catch (e) { b64 = ''; }
      return { clicked: d.clicked, name: d.name, bytes: buf.length, isPng, w, h, b64 };
    })()`));
  }

  async screenshot(name: string): Promise<string | null> {
    // 截图只是证据、不是断言：CDP 偶尔会卡（大图预览 + headless），绝不能因此中断整条链路。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.send<CaptureScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        if (!r || !r.data) throw new Error('无 data');
        const file = path.join(OUT, name);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        shots.push(name);
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
function check(cond: unknown, msg: string): void {
  if (cond) log(`  ✅ ${msg}`);
  else { problems.push(msg); log(`  ❌ ${msg}`); }
}

async function smoke(browser: Browser): Promise<void> {
  const page = await browser.newPage();
  await page.goto('data:text/html,<h1 style="font-family:sans-serif">CDP OK</h1>');
  const t = await page.text('h1');
  check(t === 'CDP OK', 'CDP 页面求值正常');
  await page.screenshot('00-smoke.png');
}

interface RoundOptions {
  shotBefore?: string;
  shotReveal?: string;
  advance?: boolean;
}

async function run(browser: Browser): Promise<{ a: Page; b: Page }> {
  log('\n[1] 玩家 A 打开首页');
  const a = await browser.newPage();
  await a.goto(APP_URL + '/');
  await a.waitFor('!!document.querySelector("#view-home")', 15000, '首页渲染');
  await a.screenshot('01-home.png');
  const homeText = await a.bodyText();
  check(/同声传意/.test(homeText), '首页标题为「同声传意」（改名验收）');
  check(!/联想词/.test(homeText), '首页不再出现旧名「联想词」');

  log('\n[2] A 创建房间');
  await a.type('#nickname-input', '小明');
  await a.click('#btn-create');
  await a.waitFor('!!document.querySelector("#view-room") && getComputedStyle(document.querySelector("#view-room")).display !== "none"', 15000, '进入房间页');
  const code = ((await a.text('#room-code')) || '').trim();
  check(/^[A-Z0-9]{4}$/.test(code), `房间码格式正确（${code}）`);
  await a.screenshot('02-room-waiting.png');

  log('\n[3] 玩家 B 通过邀请链接加入');
  const b = await browser.newPage();
  await b.goto(`${APP_URL}/?room=${encodeURIComponent(code)}`);
  await b.waitFor('!!document.querySelector("#code-input")', 15000, 'B 首页渲染');
  const prefilled = await b.eval('document.querySelector("#code-input").value');
  check(prefilled === code, `邀请链接自动预填房间码（${String(prefilled)}）`);
  await b.type('#nickname-input', '小红');
  await b.click('#btn-join');
  await b.waitFor('!!document.querySelector("#view-room") && getComputedStyle(document.querySelector("#view-room")).display !== "none"', 15000, 'B 进入房间页');
  await a.waitFor('document.body.innerText.includes("小红")', 8000, 'A 看到对手加入');
  check(true, 'A 端实时出现对手「小红」');
  await a.screenshot('03-room-both.png');

  log('\n[4] 双方准备 → 自动倒计时');
  await a.click('#btn-ready');
  await sleep(300);
  const aReadyAfterOwnClick = await a.busyState('#btn-ready');
  check(!!aReadyAfterOwnClick && !aReadyAfterOwnClick.isBusy, `A 点准备后按钮不残留 loading（is-busy=${aReadyAfterOwnClick && aReadyAfterOwnClick.isBusy}, 文字="${aReadyAfterOwnClick && aReadyAfterOwnClick.text}"）`);
  // v2.1 回归：新房绝不能被「对方还在看结算」误判而永久禁用准备
  const aTipAfterReady = (await a.text('#room-tip')) || '';
  check(!/还在看.*结算|看上一局的结算/.test(aTipAfterReady), `新房 A 点准备后不应出现「对方还在看结算」提示（tip="${aTipAfterReady.trim()}"）`);
  const aReadyEnabled = await a.busyState('#btn-ready');
  check(!!aReadyEnabled && !aReadyEnabled.disabled, `新房 A 的 #btn-ready 未被禁用（disabled=${aReadyEnabled && aReadyEnabled.disabled}）`);
  await b.click('#btn-ready');
  // 双方都准备 → 必须真的进入对局视图（失败即说明准备被前端锁死，或服务端没开局）
  await a.waitFor('(() => { const v = document.querySelector("#view-game"); if (!v) return false; const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()', 12000, '双方准备后 A 进入对局视图');
  await b.waitFor('(() => { const v = document.querySelector("#view-game"); if (!v) return false; const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()', 12000, '双方准备后 B 进入对局视图');
  check(true, '双方准备后自动开局（新房未被结算锁定误伤）');
  await sleep(500); // 等数字的弹出动画进入可见帧（countPop 从 opacity:0 开始）
  // 相位已被服务端推进（lobby → countdown），此时最容易残留 is-busy，立刻复查
  const aReadyAfterPhaseChange = await a.busyState('#btn-ready');
  check(!!aReadyAfterPhaseChange && !aReadyAfterPhaseChange.isBusy, `相位推进后 A 的准备按钮仍无 loading 残留（is-busy=${aReadyAfterPhaseChange && aReadyAfterPhaseChange.isBusy}）`);
  await a.screenshot('04-countdown.png');

  // 完整跑一轮「提交→双盲→揭晓」；advance=true 则揭晓后手动进下一轮。
  async function playRound(wa: string, wb: string, o?: RoundOptions): Promise<void> {
    const opt = o || {};
    await a.waitFor('(() => { const el = document.querySelector("#word-input"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; })()', 15000, 'A 输入开放（' + wa + '）');
    await a.type('#word-input', wa);
    await a.click('#btn-submit');
    await sleep(500);
    const bText = await b.bodyText();
    check(!bText.includes(wa), '双盲：B 提交前看不到 A 的词「' + wa + '」');
    check(/对方|等待|已提交/.test(bText), 'B 端有「对方已提交/等待」的提示');
    if (opt.shotBefore) await b.screenshot(opt.shotBefore);
    await b.waitFor('(() => { const el = document.querySelector("#word-input"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; })()', 15000, 'B 输入开放（' + wb + '）');
    await b.type('#word-input', wb);
    await b.click('#btn-submit');
    const revealExpr = '(() => { const el = document.querySelector("#reveal-a"); return !!el && el.innerText.includes(' + JSON.stringify(wa) + '); })()';
    await a.waitFor(revealExpr, 10000, 'A 揭晓 ' + wa);
    await b.waitFor(revealExpr, 10000, 'B 揭晓 ' + wa);
    if (opt.shotReveal) await a.screenshot(opt.shotReveal);
    if (opt.advance && (await a.isVisible('#btn-next'))) await a.click('#btn-next');
  }

  log('\n[5] 先连打三轮「不一样」，攒出多轮历史（导出图应是竖向时间线）');
  await playRound('山', '水', { shotBefore: '05-before-submit.png', advance: true });
  await playRound('猫', '狗', { advance: true });
  await playRound('苹果', '云朵', { shotReveal: '06-reveal.png' });

  log('\n[6] 第 3 轮揭晓「苹果 / 云朵」不一样（停留 reveal，准备走同意词流程）');
  const ra = (await a.text('#reveal-a')) ?? '';
  const rb = (await b.text('#reveal-b')) ?? '';
  check(ra.includes('苹果') && rb.includes('云朵'), `双方同时揭晓（${ra} vs ${rb}）`);
  check(/不一样|继续/.test((await a.text('#reveal-verdict')) || ''), '判定文案为「不一样，继续联想」');

  log('\n[6.5] 同意词投票：A 先投 → 必须冻结自动推进');
  check(await a.isVisible('#agree-row'), '揭晓面板出现同意词投票区 #agree-row');
  check(await a.isVisible('#btn-agree'), '#btn-agree 可点');
  await a.click('#btn-agree');
  await a.waitFor('(() => { const el = document.querySelector("#btn-agree"); return !!el && el.getAttribute("aria-pressed") === "true"; })()', 8000, 'A 投票生效');
  check(true, 'A 投出「我认为意思相同」（aria-pressed=true）');
  await b.waitFor('(() => { const el = document.querySelector("#btn-agree"); return !!el && /对方|已确认|等待/.test(el.innerText + (document.body.innerText || "")); })()', 8000, 'B 看到对方已确认').catch(() => {});
  const bSawAgree = await b.bodyText();
  check(/对方/.test(bSawAgree), 'B 端能看到对方已确认同意词的提示');
  await a.screenshot('10-agree-voted.png');

  // PROTOCOL §3/§7：一旦有人投票，本轮 4.5s 自动推进必须取消，只能手动继续
  await sleep(REVEAL_MS + 1500);
  check(await a.isVisible('#agree-row'), `投票后 ${((REVEAL_MS + 1500) / 1000).toFixed(1)}s 仍停在 reveal（自动推进已冻结）`);
  check(((await a.text('#reveal-a')) || '').includes('苹果'), '冻结期间揭晓内容未被下一轮');
  check(await a.isVisible('#btn-next'), '冻结期间仍可手动点「下一轮」');
  const overlayOn = Boolean(await a.eval('(() => { const el = document.querySelector("#countdown-overlay"); if (!el) return false; const cs = getComputedStyle(el); return cs.display !== "none" && el.classList.contains("is-on"); })()'));
  check(!overlayOn, '冻结期间没有出现倒计时遮罩（确实没进下一轮）');

  log('\n[6.5b] A 撤票 → 再投：撤票不恢复计时器');
  await a.click('#btn-agree');
  await a.waitFor('(() => { const el = document.querySelector("#btn-agree"); return !!el && el.getAttribute("aria-pressed") === "false"; })()', 8000, 'A 撤票生效');
  check(true, 'A 撤票后 aria-pressed=false');
  await sleep(600);
  check(await a.isVisible('#agree-row'), '撤票后仍停在 reveal（计时器不恢复）');
  await a.click('#btn-agree');
  await a.waitFor('(() => { const el = document.querySelector("#btn-agree"); return !!el && el.getAttribute("aria-pressed") === "true"; })()', 8000, 'A 再投生效');
  check(true, 'A 重新投出同意词票');

  log('\n[6.6] B 也投 → 双方确认同意词 → 通关');
  await b.click('#btn-agree');
  await a.waitFor('(() => { const v = document.querySelector("#view-settle"); return !!v && getComputedStyle(v).display !== "none"; })()', 12000, 'A 进入结算视图');
  await b.waitFor('(() => { const v = document.querySelector("#view-settle"); return !!v && getComputedStyle(v).display !== "none"; })()', 12000, 'B 进入结算视图');
  check(true, '双方都确认后 phase=won，两端都进入结算视图 #view-settle');
  const settleTitle = await a.text('#settle-title');
  check(/同意|确认|同义/.test(settleTitle || ''), `结算标题体现同意词通关（${(settleTitle || '').trim()}）`);
  const settleFinal = (await a.text('#settle-final')) ?? '';
  check(settleFinal.includes('苹果') && settleFinal.includes('云朵'), `结算展示最终成功的两个词（${settleFinal.trim()}）`);
  const settleRounds = (await a.text('#settle-rounds')) ?? '';
  check(
    ['山', '水', '猫', '狗', '苹果', '云朵'].every((w) => settleRounds.includes(w)),
    '结算逐轮列表包含全部 3 轮的词（竖向时间线数据完整）'
  );
  check(/3/.test((await a.text('#settle-stats')) || ''), '结算统计体现共 3 轮');
  check(/同声传意/.test((await a.bodyText()) || ''), '结算页品牌为「同声传意」');
  await a.screenshot('11-settle-agree.png');
  await b.screenshot('11b-settle-agree-b.png');

  log('\n[6.7] 导出整局词语列表图片（#btn-export）');
  await a.armDownloadHook();
  await a.click('#btn-export');
  let dl: DownloadInfo = { clicked: 0, bytes: 0, isPng: false, w: 0, h: 0, name: '' };
  for (let i = 0; i < 40 && !(dl.clicked && dl.bytes > 0); i++) {
    await sleep(250);
    dl = await a.readDownload();
  }
  check(dl.clicked > 0, `导出触发了下载（文件名：${dl.name || '—'}）`);
  check(dl.isPng, `导出内容是 PNG（${dl.bytes} 字节）`);
  check(dl.w >= 1080, `导出图宽度 ≥1080（实际 ${dl.w}×${dl.h}）`);
  // 多轮历史 → 竖向时间线长图：3 轮局应是「高 > 宽」的竖版海报
  check(dl.h > dl.w, `3 轮局导出为竖版时间线长图（${dl.w}×${dl.h}，高>宽）`);
  if (dl.b64) {
    fs.writeFileSync(path.join(OUT, '12-export.png'), Buffer.from(dl.b64, 'base64'));
    shots.push('12-export.png');
    log(`  📦 导出图已存为 .verify/shots/12-export.png（${dl.bytes} 字节, ${dl.w}×${dl.h}）`);
  }
  const exportText = await a.bodyText();
  check(!/undefined|NaN|\[object Object\]/.test(exportText), '导出后页面无 undefined/NaN 之类的脏文本');

  log('\n[7] v2.1 结算页各自退出：A 点「再来一局」，B 不得被踢出结算页');
  check(await a.isVisible('#btn-restart'), '结算视图内有 #btn-restart');
  await a.click('#btn-restart');
  await a.waitFor('(() => { const v = document.querySelector("#view-room"); return !!v && getComputedStyle(v).display !== "none"; })()', 10000, 'A 回到房间页');
  check(true, 'A 点「再来一局」后自己回到准备页');

  // 核心回归：过去 B 会被一起踢回 lobby，现在 B 必须仍停在结算页
  await sleep(1200);
  check(await b.isVisible('#view-settle'), 'B 仍停留在结算页 #view-settle（没有被强制退出）');
  check(!(await b.isVisible('#view-room')), 'B 没有被切到准备页');
  const bSettleFinal = (await b.text('#settle-final')) ?? '';
  check(bSettleFinal.includes('苹果') && bSettleFinal.includes('云朵'), `B 的结算内容仍是通关那局（${bSettleFinal.trim().replace(/\s+/g, ' ')}）`);
  check(((await b.text('#settle-rounds')) || '').includes('苹果'), 'B 的逐轮列表仍在');
  await b.screenshot('17-settle-b-still-viewing.png');

  // 留守方仍可导出
  await b.armDownloadHook();
  await b.click('#btn-export');
  let dlB: DownloadInfo = { clicked: 0, bytes: 0, isPng: false, w: 0, h: 0, name: '' };
  for (let i = 0; i < 40 && !(dlB.clicked && dlB.bytes > 0); i++) {
    await sleep(250);
    dlB = await b.readDownload();
  }
  check(dlB.clicked > 0 && dlB.isPng, `B 留在结算页仍能导出 PNG（${dlB.bytes} 字节, ${dlB.w}×${dlB.h}）`);

  // A 在对方留守期间不能把对局开起来
  await a.click('#btn-ready').catch(() => {});
  await sleep(1800);
  const aOverlay = Boolean(await a.eval('(() => { const el = document.querySelector("#countdown-overlay"); if (!el) return false; return el.classList.contains("is-on") && getComputedStyle(el).display !== "none"; })()'));
  check(!aOverlay, '对方留守结算页期间，A 点准备不会开始对局（服务端硬拒）');
  check(await a.isVisible('#view-room'), 'A 仍在准备页');
  const aTip = (await a.text('#room-tip')) || '';
  check(/结算|再来一局|等/.test(aTip), `A 的准备页给出了「对方还在看结算」的提示（${aTip.trim()}）`);
  await a.screenshot('18-room-waiting-opponent.png');

  log('\n[7b] B 也点「再来一局」→ 两人才都回准备页');
  await b.click('#btn-restart');
  await b.waitFor('(() => { const v = document.querySelector("#view-room"); return !!v && getComputedStyle(v).display !== "none"; })()', 10000, 'B 回到房间页');
  check(!(await b.isVisible('#view-settle')), 'B 点完后自己退出结算页');

  log('\n[7c] 准备按钮 bug 回归（双方都不得残留 loading）');
  const readyA = await a.busyState('#btn-ready');
  const readyB = await b.busyState('#btn-ready');
  const readyStates: Array<[string, BusyState | null]> = [['A', readyA], ['B', readyB]];
  for (const [who, st] of readyStates) {
    check(!!st, `${who} 端 #btn-ready 存在`);
    check(!!st && !st.isBusy, `${who} 端 #btn-ready 没有 is-busy 残留`);
    check(!!st && st.ariaBusy !== 'true', `${who} 端 #btn-ready 没有 aria-busy 残留`);
    check(!!st && !st.colorTransparent, `${who} 端 #btn-ready 文字颜色可见（非 transparent）`);
    check(!!st && /准备/.test(st.text), `${who} 端 #btn-ready 有文字（"${st && st.text}"）`);
  }
  await a.screenshot('13-room-after-restart.png');

  log('\n[8] 第二局：一轮就提交相同词 → 直接通关（不应出现投票区）');
  await a.click('#btn-ready');
  await sleep(300);
  const readyA2 = await a.busyState('#btn-ready');
  check(!!readyA2 && !readyA2.isBusy, `第二次点准备后仍无 loading 残留（is-busy=${readyA2 && readyA2.isBusy}）`);
  await b.click('#btn-ready');
  await a.waitFor('(() => { const el = document.querySelector("#word-input"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; })()', 15000, '第二局第 1 轮输入开放');
  await a.type('#word-input', '彩虹');
  await a.click('#btn-submit');
  await b.waitFor('(() => { const el = document.querySelector("#word-input"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; })()', 15000, 'B 第二局输入开放');
  await b.type('#word-input', '彩虹');
  await b.click('#btn-submit');
  await a.waitFor('(() => { const v = document.querySelector("#view-settle"); return !!v && getComputedStyle(v).display !== "none"; })()', 12000, 'A 第二局通关');
  check(true, '一模一样直接通关（winBy=same，无 reveal 投票机会）');
  check(!(await a.isVisible('#agree-row')), '一模一样通关时不出现 #agree-row 投票区');
  const settleTitle2 = await a.text('#settle-title');
  check(/一模一样|相同|一致/.test(settleTitle2 || ''), `结算标题体现一模一样通关（${(settleTitle2 || '').trim()}）`);
  const settleFinal2 = (await a.text('#settle-final')) ?? '';
  check(/彩虹/.test(settleFinal2), `结算最终词为「彩虹」（${settleFinal2.trim()}）`);
  const rounds2 = (await a.text('#settle-rounds')) ?? '';
  check(/彩虹/.test(rounds2), '第二局结算逐轮列表已渲染');
  await a.screenshot('14-settle-same.png');

  log('\n[9] 移动端 375px 复查（结算页 + 首页）');
  await a.setViewport(375, 812);
  await sleep(500);
  const overflowSettle = Number(await a.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  check(overflowSettle <= 2, `375px 结算页无横向溢出（overflow=${overflowSettle}px）`);
  await a.screenshot('15-mobile-375-settle.png');
  await b.click('#btn-leave-win').catch(() => {});
  await b.waitFor('(() => { const v = document.querySelector("#view-home"); return !!v && getComputedStyle(v).display !== "none"; })()', 10000, 'B 回到首页').catch(() => {});
  await b.setViewport(375, 812);
  await sleep(400);
  const overflowHome = Number(await b.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  check(overflowHome <= 2, `375px 首页无横向溢出（overflow=${overflowHome}px）`);
  await b.screenshot('16-mobile-375-home.png');
  await a.setViewport(430, 932);
  await sleep(300);

  log('\n[10] 控制台错误检查');
  const consoleErr = [...a.consoleErrors, ...b.consoleErrors].filter((e) => e && !/favicon/i.test(e));
  const pageErr = [...a.pageErrors, ...b.pageErrors];
  check(consoleErr.length === 0, `无 console error（${consoleErr.length} 条）`);
  check(pageErr.length === 0, `无未捕获异常（${pageErr.length} 条）`);
  if (consoleErr.length) console.error('  console errors:', consoleErr.slice(0, 5));
  if (pageErr.length) console.error('  page errors:', pageErr.slice(0, 5));

  return { a, b };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  let browser: Browser | undefined;
  try {
    browser = await Browser.launch();
    if (SMOKE) {
      await smoke(browser);
    } else {
      await run(browser);
    }
    console.log(`\n截图: ${shots.map((s) => path.join(OUT, s)).join(', ')}`);
    if (problems.length) {
      console.error(`\n❌ 失败 ${problems.length} 项:`);
      problems.forEach((p) => console.error('   - ' + p));
      process.exitCode = 1;
    } else {
      console.log('\n✅ 全部通过');
    }
  } catch (err) {
    console.error('\n💥 流程中断:', errorMessage(err));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

await main();
