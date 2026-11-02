<script setup lang="ts">
/**
 * 对局页（#view-game）：顶部信息 / 联想依据 / 提交面板 / 揭晓面板 / 已玩轮次。
 */
import { useGameSession } from '@/composables/useGameSession';
import PlayPanel from './PlayPanel.vue';
import RevealPanel from './RevealPanel.vue';
import HistoryList from './HistoryList.vue';

defineProps<{ active: boolean }>();

const game = useGameSession();
</script>

<template>
  <section
    id="view-game"
    class="view"
    :class="{ 'view--active': active }"
    :aria-hidden="active ? 'false' : 'true'"
    aria-label="对局"
  >
    <header class="topline game-top">
      <div class="game-top__left">
        <span id="game-round" class="game-top__round">{{ game.roundLabel }}</span>
        <span class="game-top__sep" aria-hidden="true">/</span>
        <span id="game-code" class="game-top__code">{{ game.gameCode }}</span>
      </div>
      <button id="btn-exit" class="btn-exit" type="button" @click="game.leaveRoom">退出</button>
    </header>

    <div id="basis" class="basis">
      <p class="basis__label">本轮联想依据</p>
      <p class="basis__text">{{ game.basisView.text }}</p>
      <div class="basis__words" :class="{ 'is-hidden': !game.basisView.has }">
        <template v-if="game.basisView.has">
          <span class="word-chip">{{ game.basisView.a }}</span>
          <span class="basis__x">×</span>
          <span class="word-chip">{{ game.basisView.b }}</span>
        </template>
      </div>
      <p class="basis__sub">{{ game.basisView.sub }}</p>
    </div>

    <PlayPanel />
    <RevealPanel />
    <HistoryList />
  </section>
</template>
