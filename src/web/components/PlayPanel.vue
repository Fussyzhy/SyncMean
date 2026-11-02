<script setup lang="ts">
/**
 * 提交面板（#play-panel）：输入词 / 提交 / 等待提示 / 提交时限进度条。
 * §12：提交按钮的 is-busy 由真实忙态 + 当前相位派生，不靠回调移除。
 */
import { nextTick, ref, watch } from 'vue';
import { useGameSession } from '@/composables/useGameSession';

const game = useGameSession();
const wordRef = ref<HTMLInputElement | null>(null);

function submit(): void {
  if (game.submitWord() === false) wordRef.value?.focus();
}

function onWordKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    submit();
  }
}

// 输入开放后自动聚焦（旧 renderPlay 里的 pointer:fine 判定）
watch(
  () => game.canType,
  (can) => {
    if (!can) return;
    void nextTick(() => {
      try {
        if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
          wordRef.value?.focus();
        }
      } catch {
        /* ignore */
      }
    });
  },
);
</script>

<template>
  <div id="play-panel" class="card play" :class="{ 'is-hidden': game.playHidden }">
    <label class="field__label" for="word-input">你想到的词</label>
    <input
      id="word-input"
      ref="wordRef"
      v-model="game.wordInput"
      class="input input--word"
      type="text"
      maxlength="12"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      enterkeyhint="send"
      :placeholder="game.wordPlaceholder"
      :disabled="!game.canType"
      @keydown="onWordKeydown"
    />
    <button
      id="btn-submit"
      class="btn btn--primary btn--block"
      type="button"
      :disabled="!game.canType || game.submitBusy"
      :class="{ 'is-busy': game.submitBusyShown }"
      :aria-busy="game.submitBusyShown ? 'true' : undefined"
      @click="submit"
    >
      {{ game.submitLabel }}
    </button>
    <p id="waiting-hint" class="hint" :class="{ 'is-on': game.waitingOn }">
      {{ game.waitingText }}
    </p>
    <div v-if="game.emoteVisible" id="emote-row" class="emote-row">
      <button
        v-for="opt in game.emoteOptions"
        :id="'btn-emote-' + opt.kind"
        :key="opt.kind"
        class="emote-btn"
        type="button"
        :disabled="opt.disabled"
        @click="game.sendEmote(opt.kind)"
      >
        {{ opt.emoji }} {{ opt.label }}
      </button>
    </div>
    <button
      v-if="game.opened && !game.showReveal && game.opponentOffline"
      id="btn-copy-waiting"
      class="btn btn--ghost btn--block"
      type="button"
      @click="game.copyInvite"
    >
      复制邀请链接，喊他回来
    </button>
    <p id="opponent-hint" class="hint hint--soft" :class="{ 'is-on': game.opponentHintOn }">
      对方已经提交啦，就差你 👀
    </p>
    <div
      id="timer"
      class="timer"
      :class="{ 'is-hidden': !game.timerVisible, 'timer--unlimited': game.timerUnlimited }"
    >
      <div v-if="!game.timerUnlimited" class="timer__track">
        <div
          id="timer-bar"
          class="timer__fill"
          :class="{ 'timer__fill--low': game.timerLow }"
          :style="{ width: game.timerWidth }"
        ></div>
      </div>
      <span id="timer-text" class="timer__text">{{ game.timerText }}</span>
    </div>
  </div>
</template>
