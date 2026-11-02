<script setup lang="ts">
/**
 * 揭晓面板（#reveal-panel）：两张词卡 / 判定文案 / 同意词投票 / 下一轮提示。
 *
 * #reveal-verdict 是旧 index.html 缺失的元素（已知 bug）：新版必须补上，
 * 且三态文案齐全 —— 非通关「不一样，继续联想」、相同通关、同意词通关。
 * 揭晓动画用 revealTick 换 key 重新挂载元素来重放 CSS 动画。
 */
import { useGameSession } from '@/composables/useGameSession';
import AgreeRow from './AgreeRow.vue';

const game = useGameSession();
</script>

<template>
  <section
    id="reveal-panel"
    class="reveal"
    :class="{ 'is-on': game.showReveal, 'is-win': !!(game.showReveal && game.result && game.result.isWin) }"
    aria-label="本轮揭晓"
  >
    <div class="reveal__stage">
      <div
        :key="'reveal-a-' + game.revealTick"
        id="reveal-a"
        class="reveal__card"
        :class="{ 'reveal__card--you': game.revealA.you, 'reveal__card--flip': game.showReveal }"
        :style="{ animationDelay: '0s' }"
      >
        <span class="reveal__who">{{ game.revealA.who }}</span>
        <span class="reveal__word">{{ game.revealA.word }}</span>
        <span class="reveal__note">{{ game.revealA.note }}</span>
      </div>
      <div
        :key="'reveal-b-' + game.revealTick"
        id="reveal-b"
        class="reveal__card"
        :class="{ 'reveal__card--you': game.revealB.you, 'reveal__card--flip': game.showReveal }"
        :style="{ animationDelay: '0.12s' }"
      >
        <span class="reveal__who">{{ game.revealB.who }}</span>
        <span class="reveal__word">{{ game.revealB.word }}</span>
        <span class="reveal__note">{{ game.revealB.note }}</span>
      </div>
    </div>

    <p
      :key="'verdict-' + game.revealTick"
      id="reveal-verdict"
      class="verdict"
      :class="{ 'verdict--pop': game.showReveal }"
    >
      {{ game.verdictText }}
    </p>

    <AgreeRow
      :visible="game.agreeRowVisible"
      :pressed="game.agreePressed"
      :busy="game.agreeBusyShown"
      :hint="game.agreeHintText"
      :opponent-text="game.agreeOpponentText"
      :opponent-on="game.agreeOpponentOn"
      @toggle="game.toggleAgree"
    />

    <p id="next-hint" class="next-hint" :class="{ 'is-hidden': !game.nextVisible }">
      {{ game.nextHintText }}
    </p>
    <button
      id="btn-next"
      class="btn btn--ghost btn--block"
      type="button"
      :class="{ 'is-hidden': !game.nextVisible, 'is-busy': game.nextBusyShown }"
      :aria-busy="game.nextBusyShown ? 'true' : undefined"
      :disabled="game.nextBusy"
      @click="game.nextRound"
    >
      进入下一轮
    </button>
  </section>
</template>
