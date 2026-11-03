<script setup lang="ts">
/**
 * 观战详情（#admin-room-detail）：直接用服务端推送的 admin:room:state 刷新，
 * 展示双方玩家 / submitted 布尔 / 本轮依据 / 倒计时 / 揭晓后的结果词与逐轮历史 /
 * 同意票 / 结算快照冻结时刻；房间消失时显示 #admin-room-closed。
 */
import { computed } from 'vue';
import type { AgreePair, HistoryItem, Seat, WinBy } from '@shared/protocol';
import { useAdminSocket } from '@/composables/useAdminSocket';
import { basisPhrase, flagText, formatDateTime, rowWinBy } from '@/lib/format';

const admin = useAdminSocket();

const detail = computed(() => admin.detail);
const players = computed(() =>
  detail.value && Array.isArray(detail.value.players) ? detail.value.players : [],
);
const basisText = computed(() => basisPhrase(detail.value ? detail.value.basis : null));
const result = computed(() => (detail.value ? detail.value.result : null));
const resultFlag = computed(() =>
  flagText(result.value ? winByOf(result.value) : null),
);
const history = computed(() =>
  detail.value && Array.isArray(detail.value.history) ? detail.value.history : [],
);
const settleAtText = computed(() => {
  const at = detail.value ? detail.value.settleEndedAt : null;
  return at && Number.isFinite(Number(at)) ? formatDateTime(Number(at)) : '';
});

/** 单轮通关方式：显式 winBy 优先，其次双票同意，最后退到「相同通关」 */
function winByOf(item: { isWin: boolean; agree: AgreePair; winBy: WinBy | null }): WinBy | null {
  if (item.winBy === 'agree' || item.winBy === 'same') return item.winBy;
  if (item.agree && item.agree.a === true && item.agree.b === true) return 'agree';
  if (item.isWin) return 'same';
  return null;
}

function submittedText(seat: Seat): string {
  const current = detail.value;
  if (!current || !current.submitted) return '—';
  return current.submitted[seat] ? '已提交' : '未提交';
}

function agreeText(seat: Seat): string {
  const current = detail.value;
  if (!current || !current.agree) return '—';
  return current.agree[seat] ? '同意' : '未同意';
}

function historyFlag(item: HistoryItem): string {
  return flagText(rowWinBy(item));
}
</script>

<template>
  <section id="admin-room-detail" class="admin-detail card" aria-label="观战详情">
    <header class="admin-detail__head">
      <button id="btn-admin-back" class="btn btn--plain admin-detail__back" type="button" @click="admin.closeDetail()">
        ← 返回列表
      </button>
      <span id="admin-detail-code" class="admin-detail__code">{{ admin.selectedCode }}</span>
      <span class="admin-detail__watching" :class="{ 'is-closed': !!admin.closedReason }">
        {{ admin.closedReason ? '观战结束' : '观战中' }}
      </span>
    </header>

    <p v-if="admin.closedReason" id="admin-room-closed" class="admin-detail__closed" role="alert">
      {{ admin.closedText }}
    </p>

    <template v-if="detail">
      <div class="admin-detail__topline">
        <span class="admin-detail__phase">{{ admin.phaseText(detail) }}</span>
        <span class="admin-detail__sep" aria-hidden="true">/</span>
        <span class="admin-detail__round">第 {{ detail.round }} 轮</span>
        <span class="admin-detail__timer">{{ admin.detailCountdown }}</span>
      </div>

      <div class="admin-detail__players">
        <div
          v-for="player in players"
          :key="player.seat"
          class="admin-detail__player"
          :data-seat="player.seat"
        >
          <div class="admin-detail__player-top">
            <span class="admin-detail__seat">{{ player.seat === 'a' ? '座位 A' : '座位 B' }}</span>
            <span v-if="player.isHost" class="badge badge--lime">房主</span>
            <span class="admin-detail__online" :class="{ 'is-off': !player.connected }">
              {{ player.connected ? '在线' : '离线' }}
            </span>
          </div>
          <div class="admin-detail__name">{{ player.name || '玩家' }}</div>
          <div class="admin-detail__submit-state" :class="{ 'is-on': detail.submitted && detail.submitted[player.seat] }">
            {{ submittedText(player.seat) }}
          </div>
        </div>
        <p v-if="!players.length" class="admin-detail__no-player">房间里暂时没有玩家</p>
      </div>

      <section class="admin-detail__section">
        <h3 class="admin-detail__label">本轮依据</h3>
        <p class="admin-detail__basis">{{ basisText }}</p>
      </section>

      <section class="admin-detail__section">
        <h3 class="admin-detail__label">本轮结果</h3>
        <template v-if="result">
          <div class="admin-detail__words">
            <span class="word-chip">{{ (result.words && result.words.a) || '词穷' }}</span>
            <span class="admin-detail__x" aria-hidden="true">×</span>
            <span class="word-chip">{{ (result.words && result.words.b) || '词穷' }}</span>
          </div>
          <p class="admin-detail__result-line">
            {{ result.isWin ? '已通关' : '继续联想' }}
            <span class="admin-detail__result-flag">· {{ resultFlag }}</span>
          </p>
          <p class="admin-detail__fine">
            <span v-if="result.timedOut && (result.timedOut.a || result.timedOut.b)">
              超时：{{ result.timedOut.a ? 'A' : '' }}{{ result.timedOut.a && result.timedOut.b ? '、' : '' }}{{ result.timedOut.b ? 'B' : '' }}
            </span>
            <span v-else>双方都在时限内提交</span>
          </p>
        </template>
        <p v-else class="admin-detail__fine">还没揭晓，揭晓后会显示两个词。</p>
      </section>

      <section class="admin-detail__section">
        <h3 class="admin-detail__label">同意票<span class="admin-detail__hint">（仅揭晓阶段为真实值）</span></h3>
        <p class="admin-detail__agree">
          <span class="admin-detail__agree-item">A：{{ agreeText('a') }}</span>
          <span class="admin-detail__agree-item">B：{{ agreeText('b') }}</span>
        </p>
      </section>

      <section v-if="detail.settlePending" class="admin-detail__section">
        <h3 class="admin-detail__label">结算快照</h3>
        <p class="admin-detail__fine">
          结算中{{ settleAtText ? ' · 冻结于 ' + settleAtText : '' }}
        </p>
      </section>

      <section class="admin-detail__section">
        <h3 class="admin-detail__label">逐轮历史</h3>
        <ol v-if="history.length" class="admin-detail__history">
          <li
            v-for="item in history"
            :key="item.round"
            class="admin-detail__history-item"
            :class="{ 'is-win': item.isWin }"
          >
            <span class="admin-detail__history-round">第 {{ item.round }} 轮</span>
            <span class="admin-detail__history-words">
              {{ (item.words && item.words.a) || '词穷' }} / {{ (item.words && item.words.b) || '词穷' }}
              <template v-if="item.basis">（依据「{{ item.basis.a }}」×「{{ item.basis.b }}」）</template>
            </span>
            <span class="admin-detail__history-flag">{{ historyFlag(item) }}</span>
          </li>
        </ol>
        <p v-else class="admin-detail__fine">还没有历史轮次。</p>
      </section>

      <div v-if="!admin.closedReason" class="admin-detail__actions">
        <button
          class="btn btn--ghost btn-admin-delete"
          :class="{
            'is-confirm': admin.isDeleteConfirming(admin.selectedCode),
            'is-busy': admin.isDeletePending(admin.selectedCode),
          }"
          type="button"
          :data-code="admin.selectedCode"
          :disabled="admin.isDeletePending(admin.selectedCode)"
          :aria-busy="admin.isDeletePending(admin.selectedCode) ? 'true' : undefined"
          @click="admin.requestDelete(admin.selectedCode)"
        >
          {{ admin.isDeleteConfirming(admin.selectedCode) ? '确认终止？' : '终止房间' }}
        </button>
      </div>
    </template>
  </section>
</template>
