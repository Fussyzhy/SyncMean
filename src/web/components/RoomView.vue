<script setup lang="ts">
/**
 * 房间页（#view-room）：房间码 / 复制邀请 / 玩家列表 / 准备提示 / 准备与离开。
 * 准备按钮的 disabled、loading、v2.1「对方还在看结算」锁定全部由会话派生。
 */
import { useGameSession } from '@/composables/useGameSession';
import PlayerCard from './PlayerCard.vue';

defineProps<{ active: boolean }>();

const game = useGameSession();
</script>

<template>
  <section
    id="view-room"
    class="view"
    :class="{ 'view--active': active }"
    :aria-hidden="active ? 'false' : 'true'"
    aria-label="房间"
  >
    <header class="topline">
      <span class="topline__label">等待开始</span>
      <span id="room-phase" class="topline__meta">{{ game.roomPhaseText }}</span>
    </header>

    <div class="card code-card">
      <p class="code-card__label">房间码</p>
      <div id="room-code" class="code-card__code" aria-live="polite">{{ game.roomCodeText }}</div>
      <button id="btn-copy" class="btn btn--ghost btn--block" type="button" @click="game.copyInvite">
        复制邀请链接
      </button>
    </div>

    <div id="players" class="players" aria-label="玩家列表">
      <PlayerCard seat="a" :player="game.seatA" />
      <PlayerCard seat="b" :player="game.seatB" />
    </div>

    <p id="room-tip" class="tip">{{ game.roomTip }}</p>

    <button
      id="btn-ready"
      class="btn btn--block"
      type="button"
      :class="[game.readyPressed ? 'btn--ghost' : 'btn--primary', { 'is-busy': game.readyBusyShown }]"
      :aria-pressed="game.readyPressed ? 'true' : 'false'"
      :aria-disabled="game.watchingSettle ? 'true' : undefined"
      :title="game.watchingSettle ? game.settleWatchTip : undefined"
      :disabled="game.readyDisabled"
      :aria-busy="game.readyBusyShown ? 'true' : undefined"
      @click="game.onReady"
    >
      {{ game.readyPressed ? '取消准备' : '准备' }}
    </button>
    <button id="btn-leave-room" class="btn btn--plain btn--block" type="button" @click="game.leaveRoom">
      离开房间
    </button>
  </section>
</template>
