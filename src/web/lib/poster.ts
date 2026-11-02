/**
 * 整局「海报」出图（PROTOCOL §11，纯前端 Canvas 2D，零第三方库）。
 *
 * 竖版时间线卡片：逻辑宽固定 1080（保证 dpr=1 时也不小于 1080），按 devicePixelRatio 放大；
 * 每一轮是一张卡片，沿左侧时间轴从上往下排，底部是高亮的最终通关卡。
 * 高度随轮次自适应（多轮自然成长图），美术风格沿用应用内暗色霓虹配色与系统字体栈，
 * 不联网、不取字体、不依赖图片资源。
 */

import type { SettleModel, SettleRow } from './format';

export const POSTER_W = 1080;
const POSTER_DPR_MIN = 1;
const POSTER_DPR_MAX = 3;
const POSTER_FONT =
  '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei",sans-serif';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const raw = String(text || '');
  if (!maxWidth || ctx.measureText(raw).width <= maxWidth) return raw;
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(raw.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return raw.slice(0, Math.max(0, lo)) + '…';
}

/**
 * 画布绘制主入口。
 * 返回 null 表示当前环境画不出来（无 2D context / 尺寸异常），调用方按「导出失败但不影响游戏」处理。
 */
export function drawPoster(model: SettleModel): HTMLCanvasElement | null {
  const dprRaw = Number(window.devicePixelRatio) || 1;
  const dpr = Math.min(POSTER_DPR_MAX, Math.max(POSTER_DPR_MIN, dprRaw));
  const W = POSTER_W;
  const pad = 64;
  const headerH = 250;
  const nodeColW = 78;
  const cardX = pad + nodeColW;
  const cardW = W - pad - cardX;
  const cardH = 158;
  const baseGap = 22;
  const cardStep = cardH + baseGap;
  const finalH = 214;
  const footerH = 44;
  const rows = model.rows || [];
  const N = rows.length;
  const listTop = pad + headerH + 6;
  const finalY = listTop + Math.max(1, N) * cardStep;
  const H = finalY + finalH + 30 + footerH + pad;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // ---- 背景（暗色霓虹，沿用现有风格，只改结构不改配色）----
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b1526');
  bg.addColorStop(0.55, '#091020');
  bg.addColorStop(1, '#060a12');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.12, 0, 0, W * 0.12, 0, W * 0.8);
  glow.addColorStop(0, 'rgba(62, 230, 214, 0.20)');
  glow.addColorStop(1, 'rgba(62, 230, 214, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(W * 0.95, H, 0, W * 0.95, H, W * 0.8);
  glow2.addColorStop(0, 'rgba(216, 255, 92, 0.12)');
  glow2.addColorStop(1, 'rgba(216, 255, 92, 0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // ---- 页眉 ----
  let y = pad;
  ctx.fillStyle = '#eef4ff';
  ctx.font = '700 62px ' + POSTER_FONT;
  ctx.fillText(fitText(ctx, '同声传意', W - pad * 2 - 250), pad, y);
  y += 72;

  ctx.font = '600 30px ' + POSTER_FONT;
  ctx.fillStyle = '#3ee6d6';
  ctx.fillText(fitText(ctx, model.title, W - pad * 2 - 250), pad, y);
  y += 48;

  ctx.font = '500 24px ' + POSTER_FONT;
  ctx.fillStyle = '#94a6c4';
  ctx.fillText(fitText(ctx, model.nameA + ' 与 ' + model.nameB, W - pad * 2 - 250), pad, y);
  y += 32;
  ctx.fillText(fitText(ctx, model.dateText, W - pad * 2 - 250), pad, y);

  // 房间码徽标（右上角）
  const badgeW = 232;
  const badgeH = 96;
  const badgeX = W - pad - badgeW;
  ctx.fillStyle = 'rgba(62, 230, 214, 0.10)';
  ctx.strokeStyle = 'rgba(62, 230, 214, 0.40)';
  ctx.lineWidth = 2;
  roundRect(ctx, badgeX, pad, badgeW, badgeH, 24);
  ctx.fill();
  ctx.stroke();
  ctx.font = '600 20px ' + POSTER_FONT;
  ctx.fillStyle = '#94a6c4';
  ctx.fillText('房间码', badgeX + 26, pad + 18);
  ctx.font = '700 44px ' + POSTER_FONT;
  ctx.fillStyle = '#d8ff5c';
  ctx.fillText(fitText(ctx, model.code, badgeW - 52), badgeX + 26, pad + 46);

  // 页眉分隔线
  const sepY = pad + headerH - 14;
  ctx.strokeStyle = 'rgba(140, 170, 215, 0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, sepY);
  ctx.lineTo(W - pad, sepY);
  ctx.stroke();

  // ---- 时间轴竖线 ----
  const nodeX = pad + 26;
  const firstCenter = listTop + cardH / 2;
  const lastCenter = listTop + Math.max(0, N - 1) * cardStep + cardH / 2;
  if (N >= 2) {
    ctx.strokeStyle = 'rgba(62, 230, 214, 0.30)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(nodeX, firstCenter);
    ctx.lineTo(nodeX, lastCenter);
    ctx.stroke();
  }

  // ---- 逐轮卡片（从上往下）----
  rows.forEach((row: SettleRow, index: number) => {
    const cardY = listTop + index * cardStep;
    const centerY = cardY + cardH / 2;

    // 时间轴节点（轮次序号）
    const nodeR = 24;
    ctx.beginPath();
    ctx.arc(nodeX, centerY, nodeR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(62, 230, 214, 0.18)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(62, 230, 214, 0.55)';
    ctx.stroke();
    ctx.font = '700 22px ' + POSTER_FONT;
    ctx.fillStyle = '#eef4ff';
    const numStr = String(row.round);
    ctx.fillText(numStr, nodeX - ctx.measureText(numStr).width / 2, centerY - 11);

    // 卡片
    ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.strokeStyle = 'rgba(140, 170, 215, 0.18)';
    ctx.lineWidth = 2;
    roundRect(ctx, cardX, cardY, cardW, cardH, 26);
    ctx.fill();
    ctx.stroke();

    const innerPad = 26;
    const cx = cardX + innerPad;
    const cw = cardW - innerPad * 2;

    // 卡片头：第 N 轮（左） + 通关标记胶囊（右）
    ctx.font = '600 22px ' + POSTER_FONT;
    ctx.fillStyle = '#7f93b5';
    ctx.fillText('第 ' + row.round + ' 轮', cx, cardY + 20);

    ctx.font = '600 22px ' + POSTER_FONT;
    const flagColor = row.winBy === 'agree' ? '#d8ff5c' : row.winBy === 'same' ? '#3ee6d6' : '#7f93b5';
    const flagTxt = fitText(ctx, row.flag, cw * 0.45);
    const pillH = 36;
    const pillW = ctx.measureText(flagTxt).width + 28;
    const pillX = cardX + cardW - innerPad - pillW;
    const pillY = cardY + 12;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    roundRect(ctx, pillX, pillY, pillW, pillH, 18);
    ctx.fill();
    ctx.fillStyle = flagColor;
    ctx.fillText(flagTxt, pillX + 14, pillY + 7);

    // 两个词：A（青）左 / B（粉）右
    const chipGap = 20;
    const chipW = (cw - chipGap) / 2;
    const chipY = cardY + 56;
    const chipH = 58;
    ctx.fillStyle = 'rgba(62, 230, 214, 0.12)';
    ctx.strokeStyle = 'rgba(62, 230, 214, 0.45)';
    ctx.lineWidth = 2;
    roundRect(ctx, cx, chipY, chipW, chipH, 16);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 30px ' + POSTER_FONT;
    ctx.fillStyle = '#eef4ff';
    ctx.fillText(fitText(ctx, row.a, chipW - 30), cx + 15, chipY + 13);

    const bx = cx + chipW + chipGap;
    ctx.fillStyle = 'rgba(255, 122, 182, 0.12)';
    ctx.strokeStyle = 'rgba(255, 122, 182, 0.45)';
    roundRect(ctx, bx, chipY, chipW, chipH, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#eef4ff';
    ctx.fillText(fitText(ctx, row.b, chipW - 30), bx + 15, chipY + 13);

    // 联想依据（旧实现即注释掉的版本，保持一致的版式留白）
    // ctx.font = '500 21px ' + POSTER_FONT;
    // ctx.fillStyle = '#6c7f9e';
    // const basisText =
    //   row.basisA && row.basisB
    //     ? '依据「' + row.basisA + '」×「' + row.basisB + '」继续联想'
    //     : '第一轮：随便想一个词，看能不能撞上';
    // ctx.fillText(fitText(ctx, basisText, cw), cx, chipY + chipH + 12);
  });

  // ---- 最终成功的词（高亮卡，钉在时间线底部）----
  const nodeFX = nodeX;
  const centerFY = finalY + finalH / 2;
  ctx.beginPath();
  ctx.arc(nodeFX, centerFY, 24, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(216, 255, 92, 0.20)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(216, 255, 92, 0.6)';
  ctx.stroke();
  ctx.font = '700 24px ' + POSTER_FONT;
  ctx.fillStyle = '#d8ff5c';
  const finalMark = '★';
  ctx.fillText(finalMark, nodeFX - ctx.measureText(finalMark).width / 2, centerFY - 12);

  ctx.fillStyle = 'rgba(216, 255, 92, 0.07)';
  ctx.strokeStyle = 'rgba(216, 255, 92, 0.36)';
  ctx.lineWidth = 2;
  roundRect(ctx, cardX, finalY, cardW, finalH, 28);
  ctx.fill();
  ctx.stroke();

  ctx.font = '600 22px ' + POSTER_FONT;
  ctx.fillStyle = '#d8ff5c';
  ctx.fillText('最终成功的词', cardX + 30, finalY + 24);

  // 两个大字居中，中间 ×
  ctx.font = '700 52px ' + POSTER_FONT;
  const fa = fitText(ctx, model.finalA, (cardW - 170) / 2);
  const faw = ctx.measureText(fa).width;
  const fbb = fitText(ctx, model.finalB, (cardW - 170) / 2);
  const fbw = ctx.measureText(fbb).width;
  const groupW = faw + fbw + 76;
  const gstartX = cardX + Math.max(30, (cardW - groupW) / 2);
  const bigWordY = finalY + 92;
  ctx.fillStyle = '#3ee6d6';
  ctx.fillText(fa, gstartX, bigWordY);
  ctx.font = '600 40px ' + POSTER_FONT;
  ctx.fillStyle = '#94a6c4';
  ctx.fillText('×', gstartX + faw + 18, bigWordY + 8);
  ctx.font = '700 52px ' + POSTER_FONT;
  ctx.fillStyle = '#ff7ab6';
  ctx.fillText(fbb, gstartX + faw + 58, bigWordY);

  // 通关方式 + 轮次统计（居中）
  ctx.font = '500 23px ' + POSTER_FONT;
  ctx.fillStyle = '#94a6c4';
  const statLine =
    model.title +
    ' · 共 ' +
    model.totalRounds +
    ' 轮' +
    (model.agreeRounds ? ' · 其中同意词 ' + model.agreeRounds + ' 轮' : '');
  const statTxt = fitText(ctx, statLine, cardW - 60);
  ctx.fillText(
    statTxt,
    cardX + Math.max(30, (cardW - ctx.measureText(statTxt).width) / 2),
    finalY + finalH - 42,
  );

  // ---- 页脚 ----
  ctx.font = '500 22px ' + POSTER_FONT;
  ctx.fillStyle = '#6c7f9e';
  ctx.fillText(
    fitText(ctx, '同声传意 · 双人联机 · 想到一起就通关', W - pad * 2),
    pad,
    H - pad - footerH + 20,
  );

  return canvas;
}
