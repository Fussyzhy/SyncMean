<script setup lang="ts">
/**
 * 管理后台密钥门禁（#admin-gate）。
 *
 * 只负责收集密钥并把失败文案渲染到 #admin-gate-error；
 * 真正的握手鉴权与错误映射在 useAdminSocket 里（错误原因包括
 * 密钥错误 / 频率限制 / 服务端未配置 / 断网）。
 */
import { ref } from 'vue';

const props = defineProps<{
  /** 握手鉴权中（按钮 loading，输入框禁用） */
  busy: boolean;
  /** 门禁错误文案（空串 = 不显示 #admin-gate-error） */
  error: string;
  /** 上次成功登录记住的密钥（sessionStorage），用于预填 */
  initialKey: string;
}>();

const emit = defineEmits<{ (event: 'login', key: string): void }>();

const keyInput = ref(props.initialKey || '');
const inputRef = ref<HTMLInputElement | null>(null);

function submit(): void {
  if (props.busy) return;
  const key = keyInput.value.trim();
  if (!key) {
    inputRef.value?.focus();
  }
  emit('login', key);
}
</script>

<template>
  <section id="admin-gate" class="admin-gate card" aria-label="管理后台登录">
    <p class="admin-gate__kicker">管理员入口</p>
    <h2 class="admin-gate__title">输入管理密钥</h2>
    <p class="admin-gate__sub">通过后可以实时查看房间列表、观战对局并终止房间。</p>

    <form class="admin-gate__form" @submit.prevent="submit">
      <label class="field">
        <span class="field__label">管理密钥 · ADMIN_KEY</span>
        <input
          id="admin-key-input"
          ref="inputRef"
          v-model="keyInput"
          class="input"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="输入服务端配置的 ADMIN_KEY"
          aria-label="管理密钥"
          :disabled="busy"
        />
      </label>
      <button
        id="btn-admin-login"
        class="btn btn--primary btn--block"
        type="submit"
        :disabled="busy"
        :class="{ 'is-busy': busy }"
        :aria-busy="busy ? 'true' : undefined"
      >
        进入
      </button>
    </form>

    <p v-if="error" id="admin-gate-error" class="admin-gate__error" role="alert">{{ error }}</p>

    <p class="fineprint">
      密钥由服务端 .env 的 ADMIN_KEY 配置（留空 = 管理后台禁用）；只保存在本次标签页，关闭即失效。
    </p>
  </section>
</template>
