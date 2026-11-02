<script setup lang="ts">
/** 音效开关（#btn-sound）：图标 + aria-pressed/aria-label 由 soundOn 派生。 */
import { useSound } from '@/composables/useSound';

const { soundOn, toggle } = useSound();
</script>

<template>
  <button
    id="btn-sound"
    class="sound"
    type="button"
    :aria-pressed="soundOn ? 'true' : 'false'"
    :aria-label="soundOn ? '关闭音效' : '打开音效'"
    title="音效开关"
    @click="toggle"
  >
    {{ soundOn ? '🔊' : '🔇' }}
  </button>
</template>
