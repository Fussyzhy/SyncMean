<script setup lang="ts">
/**
 * 首页（#view-home）：昵称 + 创建房间 / 输入房间码加入。
 * 只负责输入校验与焦点，真正的网络动作交给 useGameSession。
 */
import { ref, watch } from 'vue';
import { useGameSession } from '@/composables/useGameSession';
import { useToast } from '@/composables/useToast';
import { normalizeCode } from '@/lib/format';

defineProps<{ active: boolean }>();

const game = useGameSession();
const { toast } = useToast();

const nicknameRef = ref<HTMLInputElement | null>(null);
const codeRef = ref<HTMLInputElement | null>(null);
const joinRef = ref<HTMLButtonElement | null>(null);

function onCreate(): void {
  if (game.pendingCreate) return;
  const name = game.readNickname();
  if (!name) {
    nicknameRef.value?.focus();
    return;
  }
  game.createRoom(name);
}

function onJoin(): void {
  const name = game.readNickname();
  if (!name) {
    nicknameRef.value?.focus();
    return;
  }
  const code = normalizeCode(game.codeInput);
  game.codeInput = code;
  if (code.length !== 4) {
    toast('房间码是 4 位哦');
    codeRef.value?.focus();
    return;
  }
  game.joinRoom(code, name);
}

function onCodeInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  const normalized = normalizeCode(target.value);
  if (target.value !== normalized) target.value = normalized;
  game.codeInput = normalized;
}

function onNicknameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    onCreate();
  }
}

function onCodeKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    onJoin();
  }
}

// 邀请链接 ?room=CODE：预填后把焦点放到「加入」按钮（旧实现 80ms 后 focus）
watch(
  () => game.joinFocusTick,
  () => {
    joinRef.value?.focus();
  },
);
</script>

<template>
  <section
    id="view-home"
    class="view"
    :class="{ 'view--active': active }"
    :aria-hidden="active ? 'false' : 'true'"
    aria-label="首页"
  >
    <header class="brand">
      <p class="brand__kicker">双人联机 · 想到一起</p>
      <h1 class="brand__title"><span class="brand__num">同声传意</span></h1>
      <p class="brand__sub">写下您脑中的词，双方一致即可过关</p>
    </header>

    <div class="card stack">
      <div class="field">
        <label class="field__label" for="nickname-input">你的昵称</label>
        <input
          id="nickname-input"
          ref="nicknameRef"
          v-model="game.nickname"
          class="input"
          type="text"
          maxlength="12"
          autocomplete="nickname"
          spellcheck="false"
          placeholder="起个名字（最多 12 个字）"
          @keydown="onNicknameKeydown"
        />
      </div>
      <div id="submit-limit-group" class="limit" role="radiogroup" aria-label="填词时限">
        <span class="limit__label">填词时限</span>
        <div class="limit__options">
          <button
            v-for="opt in game.submitLimitOptions"
            :key="opt.ms"
            type="button"
            role="radio"
            class="limit__btn"
            :class="{ 'is-active': opt.active }"
            :data-limit-ms="opt.ms"
            :aria-checked="opt.active ? 'true' : 'false'"
            @click="game.setSubmitLimit(opt.ms)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <button
        id="btn-create"
        class="btn btn--primary btn--block"
        type="button"
        :disabled="game.pendingCreate"
        :class="{ 'is-busy': game.pendingCreate }"
        :aria-busy="game.pendingCreate ? 'true' : undefined"
        @click="onCreate"
      >
        创建房间
      </button>

      <div class="or"><span>或者加入朋友的房间</span></div>

      <div class="row">
        <input
          id="code-input"
          ref="codeRef"
          :value="game.codeInput"
          class="input input--code"
          type="text"
          inputmode="text"
          maxlength="4"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="房间码"
          aria-label="4 位房间码"
          @input="onCodeInput"
          @keydown="onCodeKeydown"
        />
        <button
          id="btn-join"
          ref="joinRef"
          class="btn btn--ghost"
          type="button"
          :disabled="game.pendingJoin"
          :class="{ 'is-busy': game.pendingJoin }"
          :aria-busy="game.pendingJoin ? 'true' : undefined"
          @click="onJoin"
        >
          加入
        </button>
      </div>
      <p class="fineprint">房间码是 4 位，大小写都行。</p>
    </div>

    <ol class="steps" aria-label="玩法">
      <li class="step"><span class="step__n">1</span>各自想一个词</li>
      <li class="step"><span class="step__n">2</span>同时揭晓</li>
      <li class="step"><span class="step__n">3</span>相同就通关</li>
    </ol>
  </section>
</template>
