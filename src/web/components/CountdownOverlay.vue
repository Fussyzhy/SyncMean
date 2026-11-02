<script setup lang="ts">
/**
 * 倒计时遮罩（#countdown-overlay）：3-2-1 数字 + 第 N 轮提示。
 * 数字换 key 重挂载以重放 countPop 动画（旧实现是 remove/offsetWidth/add 三步）。
 */
import { useCountdown } from '@/composables/useCountdown';

const { active, number, sub, pulse } = useCountdown();
</script>

<template>
  <div
    id="countdown-overlay"
    class="countdown"
    :class="{ 'is-on': active }"
    :aria-hidden="active ? 'false' : 'true'"
  >
    <div class="countdown__inner">
      <div :key="pulse" id="countdown-number" class="countdown__num countdown__num--pulse">
        {{ number }}
      </div>
      <p id="countdown-sub" class="countdown__sub">{{ sub }}</p>
    </div>
  </div>
</template>
