<script setup lang="ts">
/**
 * v3.7 全局语音条（#voice-bar）：与 NetBanner / SoundToggle 同级，四个视图都能看到。
 *
 * - 仅当「已在房间里」且 `state.voice.enabled` 时渲染；
 * - 浏览器不支持语音（非安全上下文下没有 navigator.mediaDevices）→ 整条不渲染；
 * - DOM id 固定（PROTOCOL.md §9）：#voice-bar / #btn-voice / #btn-voice-mute /
 *   #voice-status / #voice-audio，后续 E2E 按 id 验收，不得改名。
 *
 * 状态与网络动作全部在 useVoiceChat（模块级单例）里；本组件只负责渲染与点击。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useVoiceChat } from '@/composables/useVoiceChat';

const {
  supported,
  status,
  statusText,
  active,
  micMuted,
  needsGesture,
  inRoom,
  enabled,
  start,
  stop,
  toggleMute,
  resumeAudio,
  syncAudio,
} = useVoiceChat();

/** 「在房间里」+「房间开了语音」+「浏览器支持」三重条件才显示整条 */
const visible = computed(() => supported && inRoom.value && enabled.value);

const voiceLabel = computed(() => (active.value ? '关闭语音' : '开启语音'));
const muteLabel = computed(() => (micMuted.value ? '取消静音' : '静音'));

const barRef = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;

/** 点击「开启语音」必须在手势内同步进 start()，getUserMedia 才不会丢手势 */
function onToggleVoice(): void {
  if (active.value) {
    stop();
    return;
  }
  void start();
}

/**
 * 手机窄屏（< 600px）语音条与首屏内容同处顶部带，状态文案长时语音条会折成两行。
 * 这里把实际高度写进 body 的 --voice-bar-h，_voice.scss 再按需给 .app 让出顶部空间：
 * 单行（44px）时完全不改变布局，只有折行时才下推，桌面端不生效。
 */
function syncBodyFlag(on: boolean): void {
  try {
    document.body.classList.toggle('is-voice-bar', on);
    if (!on) document.body.style.removeProperty('--voice-bar-h');
  } catch {
    /* ignore */
  }
}

function measureBar(): void {
  try {
    const height = barRef.value ? barRef.value.offsetHeight : 0;
    if (height > 0) document.body.style.setProperty('--voice-bar-h', height + 'px');
  } catch {
    /* ignore */
  }
}

function stopMeasuring(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
}

watch(
  visible,
  (on) => {
    syncBodyFlag(on);
    if (!on) {
      stopMeasuring();
      return;
    }
    void nextTick(() => {
      measureBar();
      if (resizeObserver || typeof ResizeObserver === 'undefined') return;
      const el = barRef.value;
      if (!el) return;
      resizeObserver = new ResizeObserver(() => measureBar());
      resizeObserver.observe(el);
    });
  },
  { immediate: true },
);

onMounted(() => {
  // 远端流可能比音频元素先到（极少见），挂载后补挂一次
  syncAudio();
  measureBar();
});

onBeforeUnmount(() => {
  stopMeasuring();
  syncBodyFlag(false);
  // 组件卸载等价于离开语音：关 PC、停 track、清 srcObject、通知服务器
  stop();
});
</script>

<template>
  <div v-if="visible" id="voice-bar" ref="barRef" class="voice" role="group" aria-label="语音连麦">
    <span
      id="voice-status"
      class="voice__status"
      :class="'voice__status--' + status"
      role="status"
      aria-live="polite"
    >
      {{ statusText }}
    </span>

    <button
      id="btn-voice"
      class="btn btn--ghost voice__btn"
      type="button"
      :aria-pressed="active ? 'true' : 'false'"
      :aria-label="voiceLabel"
      @click="onToggleVoice"
    >
      {{ voiceLabel }}
    </button>

    <button
      v-if="active"
      id="btn-voice-mute"
      class="btn btn--ghost voice__btn voice__btn--mute"
      :class="{ 'is-muted': micMuted }"
      type="button"
      :aria-pressed="micMuted ? 'true' : 'false'"
      :aria-label="muteLabel"
      @click="toggleMute"
    >
      {{ muteLabel }}
    </button>

    <button
      v-if="needsGesture"
      id="btn-voice-play"
      class="btn btn--plain voice__btn voice__btn--play"
      type="button"
      @click="resumeAudio"
    >
      点我播放
    </button>

    <audio
      id="voice-audio"
      class="voice__audio"
      autoplay
      playsinline
      hidden
      aria-hidden="true"
    ></audio>
  </div>
</template>
