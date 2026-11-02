<script setup lang="ts">
/** 全局提示条（#toast）：2800ms 自动收起，kind 映射到 toast--* 类。 */
import { useToast } from '@/composables/useToast';

const { text, kind, on } = useToast();
</script>

<template>
  <div
    id="toast"
    class="toast"
    :class="[{ 'is-on': on }, kind ? 'toast--' + kind : '']"
    role="status"
    aria-live="polite"
  >
    {{ text }}
  </div>
</template>
