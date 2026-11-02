/**
 * 撒花层（#confetti）状态：点「一起通关」瞬间生成 36 片彩纸，4.4s 后清空。
 * 纯样式状态，失败也无所谓（旧实现就包在 try/catch 里）。
 */

import { ref } from 'vue';
import type { CSSProperties } from 'vue';

const COLORS = ['#3ee6d6', '#d8ff5c', '#ff7ab6', '#7aa2ff', '#ffd166'];
const PIECES = 36;
const CLEAR_MS = 4400;

export interface ConfettiPiece {
  id: number;
  style: CSSProperties;
}

const pieces = ref<ConfettiPiece[]>([]);
let clearTimer = 0;
let seq = 0;

export interface ConfettiApi {
  pieces: typeof pieces;
  celebrate(): void;
  clear(): void;
}

export function useConfetti(): ConfettiApi {
  function clear(): void {
    window.clearTimeout(clearTimer);
    pieces.value = [];
  }

  function celebrate(): void {
    try {
      clear();
      const next: ConfettiPiece[] = [];
      for (let i = 0; i < PIECES; i += 1) {
        seq += 1;
        const style: CSSProperties = {
          left: (Math.random() * 100).toFixed(2) + '%',
          background: COLORS[i % COLORS.length],
          width: (6 + Math.random() * 6).toFixed(1) + 'px',
          height: (10 + Math.random() * 8).toFixed(1) + 'px',
          animationDuration: (1.8 + Math.random() * 1.6).toFixed(2) + 's',
          animationDelay: (Math.random() * 0.5).toFixed(2) + 's',
          '--dx': (Math.random() * 160 - 80).toFixed(0) + 'px',
          '--rot': (Math.random() * 720 - 360).toFixed(0) + 'deg',
        };
        next.push({ id: seq, style });
      }
      pieces.value = next;
      clearTimer = window.setTimeout(() => {
        pieces.value = [];
      }, CLEAR_MS);
    } catch {
      /* 撒花失败无所谓 */
    }
  }

  return { pieces, celebrate, clear };
}
