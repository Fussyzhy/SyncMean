/**
 * 本地存储封装（旧 public/app.js 的同名键与容错语义）。
 *
 * - localStorage  ：昵称、音效开关（跨标签页共享、长期保留）
 * - sessionStorage：身份 token、对局会话（按标签页隔离、刷新保留、关标签即清理）
 *
 * 隐私模式下 localStorage / sessionStorage 的读写都可能直接抛错，这里全部吞掉并返回兜底值，
 * 绝不因为存储不可用而中断游戏。
 */

export const KEY_NICK = '321:nick';
export const KEY_TOKEN = '321:token';
export const KEY_SESSION = '321:session';
export const KEY_SOUND = '321:sound';
/**
 * 管理后台密钥（PROTOCOL.md §14.1）。
 * 只允许存 sessionStorage：刷新免重输、关标签页即失效；禁止写 localStorage / URL / DOM。
 */
export const KEY_ADMIN = '321:admin-key';
/**
 * 明暗主题的「用户显式选择」。注意：`index.html` 里的防闪烁内联脚本也硬编码了
 * 这个键名（内联脚本无法 import），改这里必须同步改 index.html。
 */
export const KEY_THEME = '321:theme';

/** 'light' | 'dark'；null 表示没选过 → 跟随系统 */
export type ThemeMode = 'light' | 'dark';

/** 存在 sessionStorage 里的对局会话（字段沿用旧实现） */
export interface StoredSession {
  code: string;
  token: string;
  name: string;
  seat: string;
}

/* ---------------- localStorage（昵称 / 音效） ---------------- */

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null | undefined): void {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    /* 隐私模式：忽略 */
  }
}

export function loadNick(): string {
  return readLocal(KEY_NICK) || '';
}

export function saveNick(name: string): void {
  writeLocal(KEY_NICK, name);
}

/** 旧实现把音效开关存成 '1' / '0'，读不到时默认开启 */
export function loadSound(): boolean {
  return readLocal(KEY_SOUND) !== '0';
}

export function saveSound(on: boolean): void {
  writeLocal(KEY_SOUND, on ? '1' : '0');
}

/**
 * 读取用户显式选择的主题。
 * 只认 'light' / 'dark'；其它值（含旧版本残留、手动改坏）一律当作「没选过」→ 跟随系统。
 */
export function loadTheme(): ThemeMode | null {
  const raw = readLocal(KEY_THEME);
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/** 传 null 表示清除显式选择、回到「跟随系统」 */
export function saveTheme(mode: ThemeMode | null): void {
  writeLocal(KEY_THEME, mode);
}

/* ---------------- sessionStorage（token / 会话） ---------------- */

function readLive(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLive(key: string, value: string | null | undefined): void {
  try {
    if (value === null || value === undefined) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, String(value));
  } catch {
    /* 隐私模式：忽略 */
  }
}

/**
 * 生成会话 token。
 * 身份 token 必须按「标签页」隔离：否则同一浏览器开两个标签页试玩时，
 * 第二个标签会读到第一个的 token，被服务端当成断线重连把对方顶掉（REPLACED）。
 */
export function makeToken(): string {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch {
    /* 继续走降级方案 */
  }
  try {
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const buf = new Uint32Array(4);
      window.crypto.getRandomValues(buf);
      return 't' + Date.now().toString(36) + '-' + Array.prototype.join.call(buf, '-');
    }
  } catch {
    /* 继续走降级方案 */
  }
  return 't' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function loadToken(): string {
  return readLive(KEY_TOKEN) || '';
}

export function saveToken(token: string): void {
  writeLive(KEY_TOKEN, token);
}

export function loadSession(): StoredSession | null {
  const raw = readLive(KEY_SESSION);
  if (!raw) return null;
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const record = obj as Record<string, unknown>;
    if (typeof record.code !== 'string' || !record.code) return null;
    return {
      code: record.code,
      token: typeof record.token === 'string' ? record.token : '',
      name: typeof record.name === 'string' ? record.name : '',
      seat: typeof record.seat === 'string' ? record.seat : '',
    };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession | null): void {
  writeLive(KEY_SESSION, session ? JSON.stringify(session) : null);
}

/* ---------------- sessionStorage（管理后台密钥） ---------------- */

export function loadAdminKey(): string {
  return readLive(KEY_ADMIN) || '';
}

/** 传空值表示清除（退出登录 / 服务端拒绝鉴权后）；只在鉴权成功后才会写入 */
export function saveAdminKey(key: string | null | undefined): void {
  writeLive(KEY_ADMIN, key);
}
