/**
 * 明暗主题（单例组合式）：默认跟随系统、兜底明亮、用户切换后写 localStorage。
 *
 * 交互（PROTOCOL.md §13）：
 *   单击 #btn-theme 在明亮/深色之间翻转并写入 321:theme（显式选择）；
 *   Shift + 单击清空该键，回到「跟随系统」；
 *   处于「跟随系统」时，系统主题变化会实时生效。
 */

import { computed, readonly, ref, type ComputedRef } from 'vue';
import { applyTheme, resolveTheme, systemTheme, watchSystemTheme } from '@/lib/theme';
import { saveTheme, type ThemeMode } from '@/lib/storage';
import type { ThemeSource } from '@/lib/theme';

const theme = ref<ThemeMode>('light');
const source = ref<ThemeSource>('system');

let unwatchSystem: (() => void) | null = null;
let initialized = false;

function commit(nextTheme: ThemeMode, nextSource: ThemeSource): void {
  theme.value = nextTheme;
  source.value = nextSource;
  applyTheme({ theme: nextTheme, source: nextSource });
}

export interface ThemeApi {
  theme: Readonly<typeof theme>;
  source: Readonly<typeof source>;
  isDark: ComputedRef<boolean>;
  init(): void;
  toggle(): ThemeMode;
  set(next: ThemeMode): void;
  reset(): void;
  dispose(): void;
}

export function useTheme(): ThemeApi {
  function init(): void {
    if (initialized) return;
    initialized = true;
    const resolved = resolveTheme();
    commit(resolved.theme, resolved.source);
    // 只有「跟随系统」时才响应系统变化；一旦用户显式选过，就以存储为准
    unwatchSystem = watchSystemTheme((next) => {
      if (source.value === 'user') return;
      commit(next, 'system');
    });
  }

  /** 显式选择某个主题并持久化 */
  function set(next: ThemeMode): void {
    saveTheme(next);
    commit(next, 'user');
  }

  /** 翻转当前呈现的主题（显式选择，覆盖系统） */
  function toggle(): ThemeMode {
    set(theme.value === 'dark' ? 'light' : 'dark');
    return theme.value;
  }

  /** 清除显式选择，回到「跟随系统」（UI 入口：Shift + 单击 #btn-theme） */
  function reset(): void {
    saveTheme(null);
    commit(systemTheme(), 'system');
  }

  function dispose(): void {
    if (unwatchSystem) {
      unwatchSystem();
      unwatchSystem = null;
    }
    initialized = false;
  }

  return {
    theme: readonly(theme),
    source: readonly(source),
    isDark: computed(() => theme.value === 'dark'),
    init,
    toggle,
    set,
    reset,
    dispose,
  };
}

/** 供 UI 显示：三种状态的中文说明 */
export function themeLabel(themeMode: ThemeMode, themeSource: ThemeSource): string {
  if (themeSource === 'system') return `跟随系统（当前${themeMode === 'dark' ? '深色' : '明亮'}）`;
  return themeMode === 'dark' ? '深色（已手动选择）' : '明亮（已手动选择）';
}
