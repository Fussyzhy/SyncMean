<script setup lang="ts">
/**
 * 管理后台根组件（/admin，PROTOCOL.md §14）。
 *
 * 只做三件事：
 * 1. 启动单例 useAdminSocket（记住的密钥自动登录）与明暗主题；
 * 2. 门禁（#admin-gate）与面板（#admin-dashboard）二选一渲染；
 * 3. 100ms ticker 驱动倒计时与「确认终止？」4s 窗口复位。
 *
 * 与游戏页完全独立：AdminApp 只在 /admin 路径挂载（见 main.ts），
 * 不改动 App.vue 与任何游戏视图的 DOM / 行为。
 */
import { nextTick, onBeforeUnmount, watch } from 'vue';
import AdminGate from '@/components/admin/AdminGate.vue';
import AdminRoomDetail from '@/components/admin/AdminRoomDetail.vue';
import AdminRoomList from '@/components/admin/AdminRoomList.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import ToastHost from '@/components/ToastHost.vue';
import { useAdminSocket } from '@/composables/useAdminSocket';
import { useTheme } from '@/composables/useTheme';

const admin = useAdminSocket();
const theme = useTheme();

// 明暗主题：index.html 内联脚本已在首屏前写好 data-theme，这里接管状态并监听系统变化
theme.init();
// 有记住的密钥则自动登录（sessionStorage，刷新免重输）
admin.init();

const ticker = window.setInterval(() => {
  admin.tickTimers();
}, 100);

onBeforeUnmount(() => {
  window.clearInterval(ticker);
});

// 从列表点「观战」后，把详情面板滚动到视口顶部（窄屏时详情在列表上方）
watch(
  () => admin.selectedCode,
  async (code) => {
    if (!code) return;
    await nextTick();
    const panel = document.getElementById('admin-room-detail');
    if (!panel || typeof panel.scrollIntoView !== 'function') return;
    try {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      panel.scrollIntoView();
    }
  },
);

function onLogin(key: string): void {
  admin.login(key);
}

function onRefresh(): void {
  if (admin.refreshing) return;
  admin.refreshRooms();
}
</script>

<template>
  <main id="view-admin" class="admin" aria-label="管理后台">
    <header class="admin-brand">
      <p class="admin-brand__kicker">同声传意 · 管理后台</p>
      <h1 class="admin-brand__title">实时对局管理</h1>
      <p class="admin-brand__sub">密钥门禁 · 实时房间列表 · 观战 · 终止房间</p>
    </header>

    <AdminGate
      v-if="admin.view === 'gate'"
      :busy="admin.gateBusy"
      :error="admin.gateError"
      :initial-key="admin.rememberedKey"
      @login="onLogin"
    />

    <section v-else id="admin-dashboard" class="admin-dashboard" aria-label="管理面板">
      <div class="admin-console card">
        <div class="admin-console__status">
          <span
            id="admin-status"
            class="admin-status"
            :class="'admin-status--' + admin.status"
            role="status"
            aria-live="polite"
          >{{ admin.statusText }}</span>
          <span class="admin-console__tip">房间列表由服务端实时推送，无需手动刷新</span>
        </div>
        <div class="admin-console__actions">
          <button
            id="btn-admin-refresh"
            class="btn btn--ghost admin-console__btn"
            type="button"
            :class="{ 'is-busy': admin.refreshing }"
            :disabled="admin.refreshing"
            :aria-busy="admin.refreshing ? 'true' : undefined"
            @click="onRefresh"
          >
            刷新
          </button>
          <button
            id="btn-admin-logout"
            class="btn btn--plain admin-console__btn"
            type="button"
            @click="admin.logout()"
          >
            退出登录
          </button>
        </div>
      </div>

      <div class="admin-metrics" aria-label="房间与玩家统计">
        <div class="admin-metric">
          <strong id="admin-room-count" class="admin-metric__num">{{ admin.totalRooms }}</strong>
          <span class="admin-metric__label">房间</span>
        </div>
        <div class="admin-metric">
          <strong id="admin-player-count" class="admin-metric__num">{{ admin.totalPlayers }}</strong>
          <span class="admin-metric__label">玩家</span>
        </div>
      </div>

      <div class="admin-body">
        <AdminRoomDetail v-if="admin.selectedCode" />
        <AdminRoomList />
      </div>
    </section>

    <ThemeToggle />
    <ToastHost />
  </main>
</template>
