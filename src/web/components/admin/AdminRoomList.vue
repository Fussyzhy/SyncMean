<script setup lang="ts">
/**
 * 实时房间列表（#admin-room-list）：服务端在内容变化时推送 admin:rooms，
 * 卡片展示房间码 / 相位 / 轮次 / 玩家在线状态 / 填词时限 / 等待时长 / 倒计时。
 *
 * 重复元素用 class + data-code 定位（PROTOCOL §14.4）：
 * .admin-room-card / .btn-admin-watch / .btn-admin-delete。
 */
import { useAdminSocket } from '@/composables/useAdminSocket';

const admin = useAdminSocket();
</script>

<template>
  <section class="admin-list-wrap" aria-label="实时房间列表">
    <header class="admin-section-head">
      <h2 class="admin-section-head__title">实时房间</h2>
      <span class="admin-section-head__hint">服务端变化时自动推送</span>
    </header>

    <div id="admin-room-list" class="admin-room-list">
      <p v-if="!admin.hasRooms" id="admin-empty" class="admin-empty">
        现在还没有房间，等玩家建房后会实时出现在这里～
      </p>

      <article
        v-for="room in admin.rooms"
        :key="room.code"
        class="admin-room-card"
        :data-code="room.code"
        :data-phase="room.settlePending ? 'settle' : room.phase"
      >
        <header class="admin-room-card__head">
          <span class="admin-room-card__code">{{ room.code }}</span>
          <span class="admin-room-card__phase">{{ admin.phaseText(room) }}</span>
          <span class="admin-room-card__round">第 {{ room.round }} 轮</span>
        </header>

        <div class="admin-room-card__players">
          <div
            v-for="player in room.players"
            :key="player.seat"
            class="admin-room-card__player"
            :data-seat="player.seat"
          >
            <span class="dot" :class="{ 'dot--off': !player.connected }"></span>
            <span class="admin-room-card__seat">{{ player.seat === 'a' ? 'A' : 'B' }}</span>
            <span class="admin-room-card__name">{{ player.name || '玩家' }}</span>
            <span v-if="player.isHost" class="badge badge--lime">房主</span>
            <span class="admin-room-card__online" :class="{ 'is-off': !player.connected }">
              {{ player.connected ? '在线' : '离线' }}
            </span>
          </div>
          <p v-if="!room.players || !room.players.length" class="admin-room-card__waiting">
            还没有玩家
          </p>
        </div>

        <dl class="admin-room-card__meta">
          <div class="admin-room-card__meta-item">
            <dt>在线 / 人数</dt>
            <dd>{{ room.onlineCount }} / {{ room.playerCount }}</dd>
          </div>
          <div class="admin-room-card__meta-item">
            <dt>填词时限</dt>
            <dd>{{ admin.submitLimitText(room) }}</dd>
          </div>
          <div class="admin-room-card__meta-item">
            <dt>等待时长</dt>
            <dd>{{ admin.waitingText(room) }}</dd>
          </div>
          <div class="admin-room-card__meta-item admin-room-card__meta-item--countdown">
            <dt>倒计时</dt>
            <dd>{{ admin.countdownText(room) }}</dd>
          </div>
        </dl>

        <div class="admin-room-card__actions">
          <button
            class="btn btn--ghost btn-admin-watch"
            type="button"
            :data-code="room.code"
            @click="admin.watchRoom(room.code)"
          >
            观战
          </button>
          <button
            class="btn btn--ghost btn-admin-delete"
            :class="{
              'is-confirm': admin.isDeleteConfirming(room.code),
              'is-busy': admin.isDeletePending(room.code),
            }"
            type="button"
            :data-code="room.code"
            :disabled="admin.isDeletePending(room.code)"
            :aria-busy="admin.isDeletePending(room.code) ? 'true' : undefined"
            @click="admin.requestDelete(room.code)"
          >
            {{ admin.isDeleteConfirming(room.code) ? '确认终止？' : '终止房间' }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
