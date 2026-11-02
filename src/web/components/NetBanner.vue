<script setup lang="ts">
/** 断线横幅（#net-banner）：连接断开/重试时从顶部滑入。 */
import { useGameSession } from '@/composables/useGameSession';

const game = useGameSession();
</script>

<template>
  <div
    id="net-banner"
    class="net"
    :class="{ 'is-on': !!game.netText }"
    role="status"
    aria-live="polite"
  >
    {{ game.netText }}
  </div>
</template>
