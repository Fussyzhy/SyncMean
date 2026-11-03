/**
 * 前端入口：同一份产物同时服务游戏页与管理后台。
 *
 * 路由只有两条（无需 vue-router）：
 * - `/admin` 及其子路径（/^\/admin(\/|$)/）→ AdminApp（管理后台）；
 * - 其余全部 → App（游戏）。
 * 两者互斥挂载，App.vue 及游戏视图的 DOM / 行为保持不变。
 */
import { createApp } from 'vue';
import App from './App.vue';
import AdminApp from './AdminApp.vue';
import './styles/main.scss';

const ADMIN_PATH = /^\/admin(\/|$)/;

if (ADMIN_PATH.test(window.location.pathname)) {
  document.title = '同声传意 · 管理后台';
  document.body.dataset.view = 'admin';
  createApp(AdminApp).mount('#app');
} else {
  createApp(App).mount('#app');
}
