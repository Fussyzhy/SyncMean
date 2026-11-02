<script setup lang="ts">
/** 撒花层（#confetti）：通关瞬间的 36 片彩纸。 */
import { useConfetti } from '@/composables/useConfetti';

const { pieces } = useConfetti();
</script>

<template>
  <div id="confetti" class="confetti" aria-hidden="true">
    <span v-for="piece in pieces" :key="piece.id" class="confetti-piece" :style="piece.style"></span>
  </div>
</template>
