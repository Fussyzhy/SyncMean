<script setup lang="ts">
/**
 * 已玩轮次（#history）：按 round 去重、新的一轮在前，与旧 renderHistory 一致。
 */
import { useGameSession } from '@/composables/useGameSession';

const game = useGameSession();
</script>

<template>
  <section class="history-wrap" aria-label="已玩轮次">
    <h2 class="history-title">已玩轮次</h2>
    <ol id="history" class="history">
      <li v-if="!game.historyItems.length" class="history__empty">
        还没有记录，第一轮先随便想一个词～
      </li>
      <li
        v-for="item in game.historyItems"
        :key="item.round"
        class="history__item"
        :class="{ 'history__item--win': item.isWin }"
      >
        <span class="history__round">第 {{ item.round }} 轮</span>
        <span class="history__words">{{ (item.words && item.words.a) || '词穷' }} / {{ (item.words && item.words.b) || '词穷' }}</span>
        <span class="history__flag">{{ item.isWin ? '通关' : '继续' }}</span>
      </li>
    </ol>
  </section>
</template>
