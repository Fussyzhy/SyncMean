<script setup lang="ts">
/**
 * 结算视图（#view-settle，v2）。
 * 数据全部来自 useGameSession 的 settleModel（只依赖 state 的 code/players/history/result），
 * 导出按钮 loading 由真实忙态派生，复制图片入口在不支持时隐藏。
 */
import { useGameSession } from '@/composables/useGameSession';

defineProps<{ active: boolean }>();

const game = useGameSession();
</script>

<template>
  <section
    id="view-settle"
    class="view"
    :class="{ 'view--active': active }"
    :aria-hidden="active ? 'false' : 'true'"
    aria-label="结算"
  >
    <header class="topline">
      <span class="topline__label">同声传意 · 本局结算</span>
      <span id="settle-flag" class="topline__meta">{{ game.settleModel ? game.settleModel.flag : '' }}</span>
    </header>

    <div class="card settle-hero">
      <p class="settle__kicker">通关方式</p>
      <h2 id="settle-title" class="settle__title">{{ game.settleModel ? game.settleModel.title : '—' }}</h2>
      <p id="settle-final" class="settle__final">
        <template v-if="game.settleModel">
          <span class="settle__word">{{ game.settleModel.finalA }}</span>
          <span class="settle__x">×</span>
          <span class="settle__word settle__word--b">{{ game.settleModel.finalB }}</span>
        </template>
      </p>
      <p id="settle-meta" class="settle__meta">{{ game.settleMeta }}</p>
    </div>

    <div class="settle-block">
      <h3 class="settle__h">逐轮词语</h3>
      <ol id="settle-rounds" class="settle-rounds">
        <template v-if="game.settleModel && game.settleModel.rows.length">
          <li
            v-for="row in game.settleModel.rows"
            :key="row.round"
            class="settle-round"
            :class="{ 'settle-round--win': !!row.winBy }"
          >
            <span class="settle-round__n">第 {{ row.round }} 轮</span>
            <span class="settle-round__words">{{ row.a }} / {{ row.b }}</span>
            <span class="settle-round__note">
              <span class="settle-round__basis">{{
                row.basisA && row.basisB ? '依据 ' + row.basisA + ' × ' + row.basisB : '第一轮：随便想'
              }}</span>
              <span class="settle-round__flag">{{ row.flag }}</span>
            </span>
          </li>
        </template>
        <li v-else class="settle-round settle-round--empty">这一局还没有留下轮次记录</li>
      </ol>
    </div>

    <p id="settle-stats" class="settle__stats">{{ game.settleStats }}</p>

    <div class="settle-actions">
      <button
        id="btn-export"
        class="btn btn--primary"
        type="button"
        :disabled="game.exportBusy"
        :class="{ 'is-busy': game.exportBusyShown }"
        :aria-busy="game.exportBusyShown ? 'true' : undefined"
        @click="game.exportImage"
      >
        导出图片
      </button>
      <button
        id="btn-export-copy"
        class="btn btn--ghost"
        type="button"
        :class="{ 'is-hidden': !game.copySupported, 'is-busy': game.exportBusyShown }"
        :disabled="!game.copySupported || game.exportBusy"
        :aria-busy="game.exportBusyShown ? 'true' : undefined"
        @click="game.copyExportImage"
      >
        复制图片
      </button>
    </div>
    <div
      id="export-preview"
      class="export-preview"
      :class="{ 'is-hidden': !game.exportPreviewUrl }"
      aria-live="polite"
    >
      <img v-if="game.exportPreviewUrl" :src="game.exportPreviewUrl" alt="本局词语列表导出图" />
    </div>

    <div class="settle-actions settle-actions--foot">
      <button
        id="btn-restart"
        class="btn btn--primary"
        type="button"
        :disabled="game.restartBusy"
        :class="{ 'is-busy': game.restartBusyShown }"
        :aria-busy="game.restartBusyShown ? 'true' : undefined"
        @click="game.restartGame"
      >
        再来一局
      </button>
      <button id="btn-leave-win" class="btn btn--ghost" type="button" @click="game.leaveRoom">离开</button>
    </div>
  </section>
</template>
