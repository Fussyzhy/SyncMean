<script setup lang="ts">
/**
 * 明暗主题切换（#btn-theme）。
 *
 * - 单击：在明亮 / 深色之间翻转，并写入 localStorage['321:theme']（显式选择）；
 * - Shift + 单击：清除显式选择，回到「跟随系统」（PROTOCOL.md §13）；
 * - 图标表示**当前**主题，aria-label 描述**下一动作**，方便读屏与自动化验收。
 */
import { computed } from 'vue';
import { themeLabel, useTheme } from '@/composables/useTheme';

const { theme, source, toggle, reset } = useTheme();

const isDark = computed(() => theme.value === 'dark');
const nextAction = computed(() => (isDark.value ? '切换到明亮模式' : '切换到深色模式'));
const title = computed(() => {
  const base = themeLabel(theme.value, source.value);
  const flip = isDark.value ? '单击切明亮' : '单击切深色';
  return `${base} · ${flip} · Shift+单击跟随系统`;
});

function onClick(event: MouseEvent): void {
  if (event.shiftKey) {
    reset();
    return;
  }
  toggle();
}
</script>

<template>
  <button
    id="btn-theme"
    class="theme"
    type="button"
    :data-theme-current="theme"
    :data-theme-source="source"
    :aria-pressed="isDark ? 'true' : 'false'"
    :aria-label="nextAction"
    :title="title"
    @click="onClick"
  >
    {{ isDark ? '🌙' : '☀️' }}
  </button>
</template>
