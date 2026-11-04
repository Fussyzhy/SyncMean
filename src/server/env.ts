/**
 * 同声传意 —— 环境变量加载（v3.5，PROTOCOL.md §14.1；v3.7 增加语音 ICE 配置）
 *
 * 只做一件很窄的事：把项目根目录 `.env` 读进 `process.env`，然后导出后端要用的配置。
 * - **进程环境变量优先**：已经存在的键（含显式空串 `ADMIN_KEY=`）一律不被 `.env` 覆盖，
 *   这样 Docker / systemd 用 `-e ADMIN_KEY=...` 就能直接覆盖本地 `.env`。
 * - 没有 `.env` 不是错误（新环境 / 只跑 `yarn test` 时都能启动）。
 * - 不引入 dotenv 依赖：解析逻辑就是下面这个纯函数，方便单测。
 *
 * 支持：BOM、CRLF、行首 `export `、单双引号包裹、空行与 `#` 注释（含行内注释）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录：`src/server/env.ts` 与编译后的 `dist/server/env.js` 都是往上两级 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录下的 `.env` 绝对路径（不存在时静默跳过） */
export const ENV_FILE = path.join(HERE, '..', '..', '.env');

/** 默认端口（PROTOCOL.md §2：PORT 未配置时用 3210） */
const DEFAULT_PORT = 3210;

/** .env 的键名格式；不满足的行直接忽略 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 去掉双引号值时支持的转义（与常见 dotenv 行为对齐，够用即可） */
function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '"':
        return '"';
      default:
        return '\\';
    }
  });
}

/**
 * 解析 `.env` 文本（纯函数：不读文件、不碰 process.env，方便单测）。
 *
 * 规则：
 * - `KEY=VALUE`，支持行首 `export `、首尾空白、CRLF、开头 BOM；
 * - 空行与 `#` 开头的行忽略；未加引号的值去掉「空白 + #」之后的行内注释；
 * - `"..."` 双引号内支持 `\n` `\r` `\t` `\"` `\\` 转义；`'...'` 单引号原样保留；
 * - 同一文件内重复键以最后一次为准。
 */
export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof text !== 'string' || text.length === 0) return result;
  // Windows 记事本可能带 UTF-8 BOM
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // 允许 `export KEY=VALUE`（方便直接 source 同一个文件）
    line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    // 跳过非法键名与危险的 `__proto__`（避免污染普通对象）
    if (!KEY_RE.test(key) || key === '__proto__') continue;

    const raw = line.slice(eq + 1).trim();
    let value: string;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      value = unescapeDoubleQuoted(raw.slice(1, -1));
    } else if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      value = raw.slice(1, -1);
    } else {
      value = raw.replace(/\s+#.*$/, '').trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * 读取并应用 `.env` 到 `process.env`（或指定的 target）。
 *
 * - 文件不存在 / 读取失败：静默返回 `{}`（不抛错、不中断启动）；
 * - **进程环境变量优先**：target 里已存在的键不覆盖（显式空串也算已配置）；
 * - 返回值是「本次真正写入 target 的键值」，方便启动日志 / 单测判断。
 */
export function loadEnvFile(
  filePath: string = ENV_FILE,
  target: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }

  const parsed = parseEnvText(text);
  const applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) continue;
    target[key] = value;
    applied[key] = value;
  }
  return applied;
}

// 模块加载即生效：index.ts 直接 `import { PORT, ADMIN_KEY }` 即可拿到最终配置。
// （与 dotenv/config 的语义一致；进程环境变量已经存在的键不会被覆盖。）
loadEnvFile();

/** 服务端口：非法或缺失回落到 3210；0 表示由系统分配（测试用） */
function resolvePort(raw: string | undefined): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return DEFAULT_PORT;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) return DEFAULT_PORT;
  return value;
}

/** 后端监听端口（进程环境变量 > .env > 3210） */
export const PORT = resolvePort(process.env.PORT);

/** 管理后台密钥；空串 = 管理后台禁用（任何 /admin socket 都会被拒绝） */
export const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();

/** 管理后台是否启用（唯一判据：ADMIN_KEY 非空） */
export const ADMIN_ENABLED = ADMIN_KEY.length > 0;

/* ==================== v3.7：语音连麦的 ICE 配置 ==================== */

/**
 * 单条 ICE 服务器配置：形状与浏览器 `RTCIceServer` 兼容（`urls` 恒为数组）。
 * 注意：TURN 的 `username` / `credential` 对玩家可见（TURN 机制决定），
 * 但**绝不打印到日志**，也不写入任何房间 / 信令数据。
 */
export interface RtcIceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/** 默认 STUN：国内可达性优先；两个都不可用时浏览器仍可用本机候选做局域网直连 */
const DEFAULT_STUN_URLS: readonly string[] = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
];

/** 逗号分隔的 URL 列表 → 去空白、去空项、去重（保持原顺序） */
export function splitUrlList(raw: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const url = part.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

/**
 * 解析 v3.7 语音 ICE 配置（纯函数，便于单测）：读取 `STUN_URLS` + 可选 TURN 三件套。
 * - `STUN_URLS` **未配置** → 用默认两条国内 STUN；配置为空串 → 不用 STUN；
 * - `TURN_URL` 非空才追加**一条** turn 服务器（可含逗号分隔的多个地址）；
 * - 用户名 / 凭据只在非空时带上（匿名 TURN 不需要）。
 */
export function resolveIceServers(env: NodeJS.ProcessEnv = process.env): RtcIceServerConfig[] {
  const stunRaw = env.STUN_URLS;
  const stunUrls = stunRaw === undefined ? DEFAULT_STUN_URLS.slice() : splitUrlList(stunRaw);

  const turnUrl = (env.TURN_URL || '').trim();
  const turnUsername = (env.TURN_USERNAME || '').trim();
  const turnCredential = (env.TURN_CREDENTIAL || '').trim();

  const iceServers: RtcIceServerConfig[] = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });
  if (turnUrl) {
    const turn: RtcIceServerConfig = { urls: splitUrlList(turnUrl) };
    if (turnUsername) turn.username = turnUsername;
    if (turnCredential) turn.credential = turnCredential;
    iceServers.push(turn);
  }
  return iceServers;
}

/** 下发给客户端的 ICE 服务器列表（GET /rtc-config；只有地址 / 可选 TURN 凭据，无任何密钥） */
export const RTC_ICE_SERVERS: RtcIceServerConfig[] = resolveIceServers();
