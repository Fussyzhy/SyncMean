/**
 * 复制文本：优先 navigator.clipboard，不可用（非安全上下文 / 权限被拒）时
 * 回落到 textarea + document.execCommand('copy')。
 */

function fallbackCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.left = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  let ok = false;
  try {
    area.focus();
    area.select();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, area.value.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  try {
    document.body.removeChild(area);
  } catch {
    /* ignore */
  }
  return ok;
}

export function copyText(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const fallback = (): void => resolve(fallbackCopy(text));
    try {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function' &&
        window.isSecureContext !== false
      ) {
        navigator.clipboard.writeText(text).then(
          () => resolve(true),
          () => fallback(),
        );
        return;
      }
    } catch {
      /* 走降级 */
    }
    fallback();
  });
}
