/**
 * 明暗主题：解析 → 应用（<html data-theme>）→ 监听系统变化。
 *
 * 解析优先级（PROTOCOL.md §13）：
 *   1. localStorage（321:theme）里有 'light' | 'dark' → 用用户选择，source = 'user'
 *   2. 否则跟随系统 prefers-color-scheme，source = 'system'
 *   3. 系统能力不可用（没有 matchMedia / 调用抛错 / matches 不是布尔）→ **兜底明亮**
 *
 * 应用方式只做三件事（样式全在 SCSS 分片里）：
 *   - 给 <html> 写 data-theme / data-theme-source
 *   - 用当前主题的 --bg-0 计算值刷新 <meta name="theme-color">
 *   - 同步 color-scheme（让原生控件/滚动条跟随主题）
 *
 * 本模块不依赖 Vue，可被组件层与单测直接调用。
 */

import { loadTheme, type ThemeMode } from './storage';

export type { ThemeMode } from './storage';

export type ThemeSource = 'system' | 'user';

export interface ResolvedTheme {
  theme: ThemeMode;
  source: ThemeSource;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** --bg-0 读不到时的静态兜底（正常情况下以 SCSS 令牌为准） */
const META_FALLBACK: Record<ThemeMode, string> = {
  light: '#f4f7fc',
  dark: '#070b14',
};

/** 当前系统偏好；任何异常都兜底为明亮 */
export function systemTheme(): ThemeMode {
  try {
    if (typeof window.matchMedia !== 'function') return 'light';
    const media = window.matchMedia(DARK_QUERY);
    if (!media || typeof media.matches !== 'boolean') return 'light';
    return media.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 按优先级算出当前应该呈现的主题 */
export function resolveTheme(): ResolvedTheme {
  const stored = loadTheme();
  if (stored) return { theme: stored, source: 'user' };
  return { theme: systemTheme(), source: 'system' };
}

/**
 * <meta name="theme-color"> 的取值：直接读当前主题下 --bg-0 的计算值，
 * 保证「配色只在一处（SCSS）定义」，TS 不复制调色板。
 */
export function metaColor(theme: ThemeMode): string {
  try {
    const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim();
    if (raw) return raw;
  } catch {
    /* 读不到就用兜底值 */
  }
  return META_FALLBACK[theme];
}

/** 把主题写进 DOM（幂等，可重复调用） */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved.theme);
  root.setAttribute('data-theme-source', resolved.source);

  try {
    root.style.colorScheme = resolved.theme;
  } catch {
    /* 老浏览器忽略即可，CSS 里另有 color-scheme 兜底 */
  }

  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', metaColor(resolved.theme));
  } catch {
    /* meta 缺失不影响功能 */
  }
}

/**
 * 监听系统主题变化，返回取消订阅函数。
 * 不支持 addEventListener 的旧实现（Safari < 14）直接返回 noop，避免抛错。
 */
export function watchSystemTheme(onChange: (theme: ThemeMode) => void): () => void {
  try {
    if (typeof window.matchMedia !== 'function') return () => {};
    const media = window.matchMedia(DARK_QUERY);
    if (!media || typeof media.addEventListener !== 'function') return () => {};
    const handler = (event: MediaQueryListEvent): void => {
      onChange(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  } catch {
    return () => {};
  }
}
