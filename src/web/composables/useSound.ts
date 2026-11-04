/**
 * WebAudio 合成音效（旧 public/app.js 的 getCtx/tone/soundXxx 移植）。
 *
 * 硬约束：任何一步失败都绝不抛出 —— 音效只是锦上添花，不能被浏览器策略拖垮游戏。
 * 首次用户手势（pointerdown）时解锁 AudioContext。
 */

import { ref } from 'vue';
import type { InteractKind } from '@shared/protocol';
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
  /** v3.6 玩家互动：三种互动各一条短提示音（接收方播放） */
  interact(kind: InteractKind): void;
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

  /**
   * v3.6 玩家互动音：三条音色互不相同，听感上分别对应「戳 / 砸 / 倒」。
   * tone() 内部已吞掉异常，这里再包一层，确保互动事件永远不会因为音效抛错。
   */
  function interact(kind: InteractKind): void {
    try {
      if (kind === 'poke') {
        // 短促上扬的「戳」：高频快击一下
        tone(1240, 0.05, 'square', 0.028);
        tone(820, 0.07, 'sine', 0.026, 0.05);
      } else if (kind === 'tomato') {
        // 低沉的「啪」：锯齿波下坠
        tone(210, 0.09, 'sawtooth', 0.032);
        tone(132, 0.13, 'triangle', 0.03, 0.07);
      } else {
        // 温润的「倒水」：两声小波浪
        tone(520, 0.12, 'sine', 0.03);
        tone(680, 0.14, 'sine', 0.028, 0.1);
      }
    } catch {
      /* 音效失败无所谓 */
    }
  }

  return { soundOn, init, toggle, unlock, tick, go, reveal, submit, win, interact };
}
