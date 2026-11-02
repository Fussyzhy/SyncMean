/**
 * 结算图导出（PROTOCOL §11 / §12）：把 poster.ts 画出的 canvas 变成可下载的 PNG。
 *
 * 优先级：canvas.toBlob → URL.createObjectURL → <a download>；
 * 回落：toDataURL → <a download>；再失败则返回明确提示（绝不抛错、绝不影响游戏）。
 * 导出为一次性动作：调用方负责防重复点击与 loading 态，这里只保证单次结果。
 * 复制到剪贴板 / 系统分享是可选增强，不支持时由调用方隐藏入口。
 */

import { drawPoster } from './poster';
import type { SettleModel } from './format';

export interface ExportOutcome {
  ok: boolean;
  message: string;
  /** 预览图地址（blob: 或 data:），失败时也可能有（下载被拦但图已生成） */
  previewUrl?: string;
}

export interface ExportCapability {
  share: boolean;
  clip: boolean;
  /** 是否展示「复制图片」入口 */
  copy: boolean;
}

interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

interface ClipboardWriteNavigator {
  clipboard?: { write?: (data: unknown[]) => Promise<void> };
}

interface ClipboardItemCtor {
  new (items: Record<string, Blob>): unknown;
}

interface CapabilityWindow {
  ClipboardItem?: ClipboardItemCtor;
}

export function exportCapability(): ExportCapability {
  let share = false;
  let clip = false;
  try {
    const nav = navigator as unknown as ShareNavigator & ClipboardWriteNavigator;
    const win = window as unknown as CapabilityWindow;
    share = typeof nav.share === 'function';
    clip = !!(
      win.ClipboardItem &&
      nav.clipboard &&
      typeof nav.clipboard.write === 'function'
    );
  } catch {
    share = false;
    clip = false;
  }
  return { share, clip, copy: share || clip };
}

/** 触发一次 <a download> 下载；返回浏览器是否接受了这次点击 */
export function triggerDownload(href: string, fileName: string): boolean {
  if (!href) return false;
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName || 'tongshengchuanyi.png';
    anchor.rel = 'noopener';
    anchor.style.position = 'fixed';
    anchor.style.left = '-2000px';
    anchor.style.top = '0';
    anchor.style.opacity = '0';
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => {
      try {
        if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);
      } catch {
        /* ignore */
      }
    }, 1500);
    return true;
  } catch {
    return false;
  }
}

/**
 * 导出整局海报。Promise 永远 resolve，不会 reject。
 * 失败时的 message 文案与旧实现一致（可直接 toast）。
 */
export function exportPoster(model: SettleModel): Promise<ExportOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ExportOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const fail = (message: string, previewUrl?: string): void =>
      finish({ ok: false, message, previewUrl });
    const succeed = (message: string, previewUrl?: string): void =>
      finish({ ok: true, message, previewUrl });

    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = drawPoster(model);
    } catch {
      canvas = null;
    }
    if (!canvas) {
      fail('这台设备画不出图片，游戏不受影响，可以手动截图保存');
      return;
    }
    const cv = canvas;

    // 回落路径：toDataURL
    const viaDataUrl = (): boolean => {
      let url = '';
      try {
        url = cv.toDataURL('image/png');
      } catch {
        url = '';
      }
      if (!url || url.indexOf('data:image/png') !== 0) return false;
      const clicked = triggerDownload(url, model.fileName);
      if (!clicked) {
        fail('浏览器拦住了下载，可以长按/右键预览图保存', url);
        return true;
      }
      succeed('图片已导出（PNG）', url);
      return true;
    };

    try {
      if (typeof cv.toBlob !== 'function') {
        if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
        return;
      }
      cv.toBlob(
        (blob) => {
          if (settled) return;
          let url = '';
          try {
            if (blob && window.URL && typeof URL.createObjectURL === 'function') {
              url = URL.createObjectURL(blob);
            }
          } catch {
            url = '';
          }
          if (!url) {
            if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
            return;
          }
          const clicked = triggerDownload(url, model.fileName);
          // 留足时间给浏览器/系统读取，之后回收，避免内存泄漏
          window.setTimeout(() => {
            try {
              URL.revokeObjectURL(url);
            } catch {
              /* ignore */
            }
          }, 60000);
          if (!clicked) {
            fail('浏览器拦住了下载，可以长按/右键预览图保存', url);
            return;
          }
          succeed('图片已导出，去下载文件夹看看', url);
        },
        'image/png',
      );
      // toBlob 个别环境不回调，超时后走 dataURL 回落
      window.setTimeout(() => {
        if (settled) return;
        if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
      }, 4000);
    } catch {
      if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
    }
  });
}

/** 可选增强：复制到剪贴板 / 系统分享（不支持时调用方隐藏入口） */
export function copyPoster(model: SettleModel): Promise<ExportOutcome> {
  return new Promise((resolve) => {
    const cap = exportCapability();
    let settled = false;
    const done = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, message });
    };

    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = drawPoster(model);
    } catch {
      canvas = null;
    }
    const cv = canvas;
    if (!cv || typeof cv.toBlob !== 'function') {
      done(false, '这台设备生成不了图片，用「导出图片」下载吧');
      return;
    }

    try {
      cv.toBlob(
        (blob) => {
          if (!blob) {
            done(false, '生成图片失败了，用「导出图片」再试一次');
            return;
          }
          shareOrCopy(blob, cap, model, done);
        },
        'image/png',
      );
    } catch {
      done(false, '生成图片失败了，用「导出图片」再试一次');
    }
  });
}

function shareOrCopy(
  blob: Blob,
  cap: ExportCapability,
  model: SettleModel,
  done: (ok: boolean, message: string) => void,
): void {
  const nav = navigator as unknown as ShareNavigator & ClipboardWriteNavigator;

  // 1) 系统分享（仅当 canShare 明确认可带文件分享时）
  if (cap.share && typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    try {
      const file = new File([blob], model.fileName, { type: 'image/png' });
      const data: ShareData = {
        files: [file],
        title: '同声传意',
        text: model.code + ' · ' + model.title,
      };
      if (nav.canShare(data)) {
        const pending = nav.share(data);
        if (pending && typeof pending.then === 'function') {
          void pending.then(
            () => done(true, '已经打开系统分享'),
            () => done(true, '已取消分享，图片仍然可以下载'),
          );
        } else {
          done(true, '已经打开系统分享');
        }
        return;
      }
    } catch {
      /* 落到剪贴板 */
    }
  }

  // 2) 复制图片到剪贴板
  if (cap.clip && nav.clipboard && typeof nav.clipboard.write === 'function') {
    try {
      const Ctor = (window as unknown as CapabilityWindow).ClipboardItem;
      if (!Ctor) {
        done(false, '这台设备不支持复制图片，用「导出图片」下载吧');
        return;
      }
      const item = new Ctor({ 'image/png': blob });
      const pending = nav.clipboard.write([item]);
      if (pending && typeof pending.then === 'function') {
        void pending.then(
          () => done(true, '图片已复制到剪贴板'),
          () => done(false, '复制被浏览器拒绝了，用「导出图片」下载就行'),
        );
      } else {
        done(true, '图片已复制到剪贴板');
      }
      return;
    } catch {
      done(false, '复制失败了，用「导出图片」下载就行');
      return;
    }
  }

  done(false, '这台设备不支持复制图片，用「导出图片」下载吧');
}
