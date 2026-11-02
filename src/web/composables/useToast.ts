/**
 * 全局提示条（#toast）状态机。
 * 单例：任何组件/组合式函数调用 useToast() 拿到的都是同一条 toast。
 * 旧实现：显示 2800ms 后自动收起；kind 只用于附加 class（join/leave/info/system）。
 */

import { ref } from 'vue';
import type { NoticeKind } from '@shared/protocol';

const TOAST_MS = 2800;

const text = ref('');
const kind = ref<NoticeKind | ''>('');
const on = ref(false);
let timer = 0;

export interface ToastApi {
  text: typeof text;
  kind: typeof kind;
  on: typeof on;
  toast(message: string, kind?: string): void;
}

export function useToast(): ToastApi {
  function toast(message: string, nextKind?: string): void {
    if (!message) return;
    text.value = String(message);
    kind.value = (nextKind as NoticeKind | undefined) || '';
    on.value = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      on.value = false;
    }, TOAST_MS);
  }

  return { text, kind, on, toast };
}
