<script setup lang="ts">
/**
 * 同意词投票区（#agree-row）：仅 phase=reveal 且本轮未通关时出现。
 * 文案四态与旧 renderAgree 一致；按钮 aria-pressed 表示本人是否已投。
 */
defineProps<{
  visible: boolean;
  pressed: boolean;
  busy: boolean;
  hint: string;
  opponentText: string;
  opponentOn: boolean;
}>();

const emit = defineEmits<{ (event: 'toggle'): void }>();
</script>

<template>
  <div id="agree-row" class="agree" :class="{ 'is-on': visible }" :aria-hidden="visible ? 'false' : 'true'">
    <button
      id="btn-agree"
      class="btn btn--ghost agree__btn"
      type="button"
      :class="{ 'agree__btn--on': pressed, 'is-busy': busy }"
      :aria-pressed="pressed ? 'true' : 'false'"
      :aria-busy="busy ? 'true' : undefined"
      :disabled="busy"
      @click="emit('toggle')"
    >
      {{ pressed ? '已确认，等对方' : '我认为意思相同' }}
    </button>
    <p id="agree-hint" class="agree__hint">{{ hint }}</p>
    <p id="agree-opponent" class="agree__opponent" :class="{ 'is-on': opponentOn }" aria-live="polite">
      {{ opponentText }}
    </p>
  </div>
</template>
