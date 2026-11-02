<script setup lang="ts">
/**
 * 应用根组件：
 * - 四个视图常驻 DOM（与旧 index.html 一致），按 state.phase 派发 view--active；
 * - 全局层：#btn-sound / #net-banner / #countdown-overlay / #confetti / #toast；
 * - 启动旧 init() 的等价物 + 100ms 主循环（倒计时数字与提交进度条）。
 */
import { onBeforeUnmount, watch } from 'vue';
import HomeView from '@/components/HomeView.vue';
import RoomView from '@/components/RoomView.vue';
import GameView from '@/components/GameView.vue';
import SettleView from '@/components/SettleView.vue';
import CountdownOverlay from '@/components/CountdownOverlay.vue';
import ConfettiLayer from '@/components/ConfettiLayer.vue';
import ToastHost from '@/components/ToastHost.vue';
import NetBanner from '@/components/NetBanner.vue';
import SoundToggle from '@/components/SoundToggle.vue';
import { useGameSession } from '@/composables/useGameSession';
import { useCountdown } from '@/composables/useCountdown';

const game = useGameSession();
const clock = useCountdown();

// 旧 init()：token / 会话 / 昵称 / 音效 / 邀请链接 / socket（同步完成，子组件挂载前就绪）
game.init();

// 旧 showView()：body.dataset.view + 切换视图时平滑回到顶部
watch(
  () => game.view,
  (name, prev) => {
    document.body.dataset.view = name;
    if (prev && prev !== name) {
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        window.scrollTo(0, 0);
      }
    }
  },
  { immediate: true },
);

// 旧 loop()：tickCountdown + tickTimers
const ticker = window.setInterval(() => {
  clock.tick();
  game.tickTimers();
}, 100);

onBeforeUnmount(() => {
  window.clearInterval(ticker);
});
</script>

<template>
  <SoundToggle />
  <NetBanner />

  <main class="app">
    <HomeView :active="game.view === 'home'" />
    <RoomView :active="game.view === 'room'" />
    <GameView :active="game.view === 'game'" />
    <SettleView :active="game.view === 'settle'" />
  </main>

  <CountdownOverlay />
  <ConfettiLayer />
  <ToastHost />
</template>
