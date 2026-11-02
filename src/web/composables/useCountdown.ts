/**
 * 3-2-1 倒计时遮罩（#countdown-overlay）状态机。
 *
 * 旧实现要点：
 * - startCountdown(round, endsAt, phrase)：同一轮只启动一次；
 * - ensureCountdown(state)：从 room:state 的 deadline 兜底启动（超长/已过期都做钳制）；
 * - tick()：外部 100ms 循环驱动，数字变化时重放脉冲动画并播放 tick 音效；
 * - 结束/重置时收起遮罩，结束时播「开始」音。
 */

import { ref } from 'vue';
import type { PublicRoomState } from '@shared/protocol';
import { basisPhrase } from '@/lib/format';
import { useSound } from './useSound';

const COUNTDOWN_FALLBACK_MS = 3000;

const active = ref(false);
const number = ref('3');
const sub = ref('准备联想…');
const pulse = ref(0);

let round = 0;
let endsAt = 0;
let shown = -1;
let doneRound = 0;

export interface CountdownApi {
  active: typeof active;
  number: typeof number;
  sub: typeof sub;
  pulse: typeof pulse;
  startCountdown(round: number, endsAt: number, phrase?: string): void;
  ensureCountdown(state: PublicRoomState): void;
  tick(force?: boolean): void;
  endCountdown(round?: number): void;
  resetCountdown(): void;
  currentRound(): number;
}

export function useCountdown(): CountdownApi {
  const sound = useSound();

  function startCountdown(nextRound: number, endsAtMs: number, phrase?: string): void {
    if (active.value && round === nextRound) return;
    round = nextRound;
    endsAt = endsAtMs;
    shown = -1;
    active.value = true;
    sub.value = '第 ' + nextRound + ' 轮 · ' + (phrase || '准备联想…');
    tick(true);
  }

  function ensureCountdown(state: PublicRoomState): void {
    const stateRound = Number(state.round) || 1;
    if (doneRound === stateRound) return;
    if (active.value && round === stateRound) return;
    const now = Date.now();
    const raw = Number(state.deadline);
    let end = raw;
    if (!end || !isFinite(end)) end = now + COUNTDOWN_FALLBACK_MS;
    const remain = end - now;
    if (remain > 6000) end = now + COUNTDOWN_FALLBACK_MS;
    else if (remain < 0) end = now + 400;
    startCountdown(stateRound, end, basisPhrase(state.basis));
  }

  function tick(force = false): void {
    if (!active.value) return;
    const remain = endsAt - Date.now();
    const next = Math.max(0, Math.min(9, Math.ceil(remain / 1000)));
    if (force || next !== shown) {
      shown = next;
      number.value = String(next > 0 ? next : 1);
      pulse.value += 1;
      if (next > 0) sound.tick(next);
    }
    if (remain <= 0) endCountdown(round);
  }

  function endCountdown(finishedRound?: number): void {
    const had = active.value;
    active.value = false;
    if (finishedRound) doneRound = finishedRound;
    if (had) sound.go();
  }

  function resetCountdown(): void {
    active.value = false;
    number.value = '3';
  }

  function currentRound(): number {
    return active.value ? round : 0;
  }

  return {
    active,
    number,
    sub,
    pulse,
    startCountdown,
    ensureCountdown,
    tick,
    endCountdown,
    resetCountdown,
    currentRound,
  };
}
