/**
 * WebAudio 合成音效（旧 public/app.js 的 getCtx/tone/soundXxx 移植）。
 *
 * 硬约束：任何一步失败都绝不抛出 —— 音效只是锦上添花，不能被浏览器策略拖垮游戏。
 * 首次用户手势（pointerdown）时解锁 AudioContext。
 */

import { ref } from 'vue';
import { loadSound, saveSound } from '@/lib/storage';

let audioCtx: AudioContext | null = null;

const soundOn = ref(true);

type AudioContextCtor = typeof AudioContext;

interface AudioWindow {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
}

function getCtx(): AudioContext | null {
  if (!soundOn.value) return null;
  try {
    const win = window as unknown as AudioWindow;
    const Ctor = win.AudioContext || win.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended') {
      const pending = audioCtx.resume();
      if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  peak: number,
  delay = 0,
): void {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const when = ctx.currentTime + delay;
    const length = Math.max(0.05, dur || 0.1);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak || 0.05, when + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + length + 0.04);
  } catch {
    /* 音效失败无所谓 */
  }
}

export interface SoundApi {
  soundOn: typeof soundOn;
  init(): void;
  toggle(): void;
  unlock(): void;
  tick(n: number): void;
  go(): void;
  reveal(): void;
  submit(): void;
  win(): void;
}

export function useSound(): SoundApi {
  function init(): void {
    soundOn.value = loadSound();
  }

  function toggle(): void {
    soundOn.value = !soundOn.value;
    saveSound(soundOn.value);
    if (soundOn.value) {
      getCtx();
      tone(880, 0.08, 'sine', 0.04);
    }
  }

  function unlock(): void {
    getCtx();
  }

  function tick(n: number): void {
    tone(n <= 1 ? 880 : 620, 0.1, 'sine', 0.05);
  }

  function go(): void {
    tone(1046, 0.16, 'triangle', 0.05);
  }

  function reveal(): void {
    tone(520, 0.1, 'sine', 0.04);
    tone(660, 0.12, 'sine', 0.038, 0.1);
  }

  function submit(): void {
    tone(780, 0.06, 'sine', 0.035);
  }

  function win(): void {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.05, i * 0.11));
  }

  return { soundOn, init, toggle, unlock, tick, go, reveal, submit, win };
}
