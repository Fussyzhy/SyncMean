<script setup lang="ts">
/**
 * 房间页里的单个玩家卡片（旧 playerCard()）。
 * 空位（player === null）渲染「等待加入…」，与旧 DOM 结构一致。
 */
import { computed } from 'vue';
import type { PublicPlayer, Seat } from '@shared/protocol';

const props = defineProps<{
  seat: Seat;
  player: PublicPlayer | null;
}>();

const initial = computed(() => {
  if (!props.player) return '+';
  const chars = Array.from(String(props.player.name || '?'));
  return chars[0] || '?';
});
</script>

<template>
  <div
    class="player"
    :class="['player--' + seat, { 'player--you': !!player && player.isYou, 'player--empty': !player }]"
  >
    <div class="player__avatar">{{ player ? initial : '+' }}</div>
    <div class="player__body">
      <template v-if="player">
        <div class="player__name">{{ player.name || '玩家' }}</div>
        <div class="player__badges">
          <span v-if="player.isHost" class="badge badge--lime">房主</span>
          <span v-if="player.isYou" class="badge">你</span>
          <span
            class="badge"
            :class="player.ready ? 'badge--ready' : 'badge--muted'"
          >{{ player.ready ? '已准备' : '未准备' }}</span>
        </div>
        <div class="player__status">
          <span class="dot" :class="{ 'dot--off': !player.connected }"></span>
          <span>{{ player.connected ? '在线' : '离线' }}</span>
        </div>
      </template>
      <template v-else>
        <div class="player__name">等待加入…</div>
        <div class="player__status">把房间码发过去</div>
      </template>
    </div>
  </div>
</template>
