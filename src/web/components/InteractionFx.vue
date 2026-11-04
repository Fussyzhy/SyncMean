<script setup lang="ts">
/**
 * 互动特效层（#interact-fx）：纯展示组件，状态来自 useInteractionFx 的模块级单例。
 *
 * DOM 契约（e2e 依赖）：
 *   #interact-fx[aria-hidden="true"] > .fx-item.fx-item--<kind>[data-kind]
 * 容器固定定位、pointer-events:none，永远不拦截点击；特效播完由 composable 的定时器移除节点。
 */
import { useInteractionFx } from '@/composables/useInteractionFx';

const { effects } = useInteractionFx();
</script>

<template>
  <div id="interact-fx" aria-hidden="true">
    <div
      v-for="effect in effects"
      :key="effect.id"
      class="fx-item"
      :class="'fx-item--' + effect.kind"
      :data-kind="effect.kind"
      :style="effect.style"
    >
      <!-- 1) 戳一戳：手从一侧伸入 → 命中（JS 给 body 挂 is-fx-shake）→ 冲击波纹 -->
      <template v-if="effect.kind === 'poke'">
        <div class="fx-finger">
          <svg
            class="fx-finger__art"
            viewBox="0 0 210 120"
            xmlns="http://www.w3.org/2000/svg"
            focusable="false"
          >
            <defs>
              <linearGradient :id="`fx-skin-${effect.id}`" x1="0" y1="0" x2="0.45" y2="1">
                <stop offset="0" stop-color="#ffe6d2" />
                <stop offset="0.55" stop-color="#ffd7b5" />
                <stop offset="1" stop-color="#f2b98f" />
              </linearGradient>
              <radialGradient :id="`fx-nail-${effect.id}`" cx="0.42" cy="0.3" r="0.75">
                <stop offset="0" stop-color="#fffaf4" />
                <stop offset="1" stop-color="#ffd9c4" />
              </radialGradient>
            </defs>
            <!-- 手腕 -->
            <rect
              x="0"
              y="48"
              width="52"
              height="62"
              rx="24"
              :fill="`url(#fx-skin-${effect.id})`"
              stroke="#dc9d73"
              stroke-width="1.5"
            />
            <!-- 手掌（手背） -->
            <circle
              cx="82"
              cy="78"
              r="40"
              :fill="`url(#fx-skin-${effect.id})`"
              stroke="#dc9d73"
              stroke-width="1.5"
            />
            <!-- 蜷起的其余手指 -->
            <rect
              x="102"
              y="66"
              width="64"
              height="30"
              rx="15"
              fill="#f6c6a0"
              stroke="#dc9d73"
              stroke-width="1.5"
            />
            <rect
              x="108"
              y="90"
              width="50"
              height="24"
              rx="12"
              fill="#efb98f"
              stroke="#dc9d73"
              stroke-width="1.5"
            />
            <!-- 伸出的食指 -->
            <rect
              x="84"
              y="28"
              width="118"
              height="40"
              rx="20"
              :fill="`url(#fx-skin-${effect.id})`"
              stroke="#dc9d73"
              stroke-width="1.5"
            />
            <rect x="96" y="34" width="96" height="10" rx="5" fill="#fff" opacity="0.35" />
            <rect x="96" y="56" width="96" height="8" rx="4" fill="#f0bb94" opacity="0.5" />
            <!-- 指节折痕 -->
            <path
              d="M120 32c-2 9-2 22 0 31"
              stroke="#e3aa82"
              stroke-width="2"
              stroke-linecap="round"
              opacity="0.45"
            />
            <path
              d="M148 32c-2 9-2 22 0 31"
              stroke="#e3aa82"
              stroke-width="2"
              stroke-linecap="round"
              opacity="0.45"
            />
            <!-- 指甲 + 高光 -->
            <ellipse
              cx="190"
              cy="48"
              rx="13"
              ry="10.5"
              :fill="`url(#fx-nail-${effect.id})`"
              stroke="#e2a377"
              stroke-width="1.5"
            />
            <ellipse cx="186.5" cy="44.5" rx="5" ry="3.2" fill="#fff" opacity="0.75" />
            <!-- 拇指 -->
            <path
              d="M62 96c16-10 34-8 41 2 5 9-2 19-15 21-12 2-23-4-26-12z"
              :fill="`url(#fx-skin-${effect.id})`"
              stroke="#dc9d73"
              stroke-width="1.5"
            />
          </svg>
        </div>
        <span class="fx-ring"></span>
        <span class="fx-ring fx-ring--late"></span>
        <span class="fx-hit-core"></span>
      </template>

      <!-- 2) 扔番茄：抛物线番茄 → 爆汁 + 酱渍 + 全屏红闪 -->
      <template v-else-if="effect.kind === 'tomato'">
        <span class="fx-tomato">
          <span class="fx-tomato__leaf"></span>
          <span class="fx-tomato__gloss"></span>
        </span>
        <div class="fx-burst">
          <span v-for="(bit, i) in effect.bits" :key="i" class="fx-bit" :style="bit"></span>
        </div>
        <span class="fx-stain"></span>
        <span class="fx-flash fx-flash--tomato"></span>
      </template>

      <!-- 3) 倒咖啡：杯子倾倒 → 液柱流下 → 底部水滩 + 飞溅 + 暖棕闪 -->
      <template v-else>
        <div class="fx-cup">
          <span class="fx-cup__handle"></span>
          <span class="fx-cup__body"><span class="fx-cup__coffee"></span></span>
        </div>
        <div class="fx-stream"></div>
        <div class="fx-pool"></div>
        <div class="fx-drops">
          <span v-for="(drop, i) in effect.bits" :key="i" class="fx-drop" :style="drop"></span>
        </div>
        <span class="fx-flash fx-flash--coffee"></span>
      </template>
    </div>
  </div>
</template>
