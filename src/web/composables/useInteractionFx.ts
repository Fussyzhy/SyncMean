/**
 * 玩家互动特效层（#interact-fx）状态：戳一戳 / 扔番茄 / 倒咖啡。
 *
 * 设计要点：
 * - 模块级单例（与 useConfetti 同款）：任何组件里调用 useInteractionFx() 拿到的都是同一份
 *   effects 与同一组 play/clear，<InteractionFx /> 只需在 App.vue 挂一次；
 * - play(kind) 立即 push 一条 { id, kind, style, bits }，到时长（poke 1100 / tomato 1600 /
 *   coffee 2000ms）自动移除；多条特效可叠加、互不打断（各自独立 DOM 节点 + 独立定时器）；
 * - 位置 / 方向 / 粒子参数全部以 CSS 自定义属性写进 style / bits，样式层（_interact.scss +
 *   _animations.scss）只负责动画表现；
 * - poke 命中瞬间给 <body> 挂 is-fx-shake，约 450ms 后由 JS 摘掉；CSS 是
 *   `body.is-fx-shake .app { animation: fxShake ... }`——摇 .app 而不是 transform body，
 *   因为 body 上有 fixed 的网格遮罩 / 浮层，变换 body 会让这些 fixed 元素的定位基准跳变。
 *
 * 失败兜底：所有副作用包 try/catch —— 特效只是彩头，任何异常都不能影响互动本身。
 */

import { ref } from 'vue';
import type { CSSProperties, Ref } from 'vue';
import type { InteractKind } from '@shared/protocol';

/** 每种互动的整段特效时长（毫秒）：到点后该条特效自动移除 */
export const INTERACTION_FX_MS: Record<InteractKind, number> = {
  poke: 1100,
  tomato: 1600,
  coffee: 2000,
};

/**
 * 命中时刻（毫秒）：摇屏 / 爆汁 / 落地闪屏都踩这个节拍。
 * 必须与 _animations.scss 里对应关键帧的百分比对齐（poke 26%~31% / tomato 45% / coffee 60%）。
 */
const HIT_MS: Record<InteractKind, number> = {
  poke: 330,
  tomato: 720,
  coffee: 1200,
};

/** 摇屏时长，与 fxShake 的 0.45s 对齐 */
const SHAKE_MS = 450;

export interface InteractionEffect {
  id: number;
  kind: InteractKind;
  /** 根节点内联样式：戳点 / 飞行方向 / 时长等 CSS 变量（后代元素继承） */
  style: CSSProperties;
  /** 粒子层（番茄果汁 / 咖啡液滴）：每个元素一条内联 CSS 变量；poke 为空数组 */
  bits: CSSProperties[];
}

export interface InteractionFxApi {
  effects: Ref<InteractionEffect[]>;
  play(kind: InteractKind): void;
  clear(): void;
}

/* ==================== 模块级单例状态 ==================== */

const effects = ref<InteractionEffect[]>([]);

let seq = 0;
const timers = new Map<number, number>();
let shakeDelayTimer = 0;
let shakeOffTimer = 0;

/* ==================== 随机 / 格式化助手 ==================== */

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function px(value: number): string {
  return value.toFixed(0) + 'px';
}

function pct(value: number): string {
  return value.toFixed(1) + '%';
}

function vh(value: number): string {
  return value.toFixed(1) + 'vh';
}

const JUICE_COLORS = ['#ff8a3d', '#e23b3b', '#ffb35c', '#ff6b4a', '#c62d2d'];

/* ==================== 三种特效的内联变量 ==================== */

/**
 * 戳一戳：手从屏幕某一侧快速伸入，指尖落在 (--fx-x, --fx-y)。
 * --fx-end-x 是“指尖对齐锚点”所需的水平位移（左手 -100% / 右手 0%，配合 --fx-mirror 镜像）；
 * --fx-off-x 是飞入前的屏外起点；--fx-push 是命中时再往前顶一点的过冲量。
 */
function buildPokeStyle(): CSSProperties {
  const fromRight = Math.random() < 0.42;
  const dir = fromRight ? -1 : 1;
  return {
    '--fx-dur': INTERACTION_FX_MS.poke + 'ms',
    '--fx-hit': HIT_MS.poke + 'ms',
    '--fx-x': pct(rand(44, 54)),
    '--fx-y': pct(rand(30, 40)),
    // 指尖在 SVG 里位于宽度 96% 处：左手用 -96% 对齐锚点，右手镜像后用 4%
    '--fx-end-x': fromRight ? '4%' : '-96%',
    '--fx-off-x': (dir * rand(62, 84)).toFixed(0) + 'vw',
    '--fx-push': px(dir * rand(8, 14)),
    '--fx-mirror': fromRight ? '-1' : '1',
    '--fx-rot0': (dir * rand(12, 22)).toFixed(0) + 'deg',
    '--fx-rot1': (dir * rand(2, 5)).toFixed(0) + 'deg',
    '--fx-rot2': (dir * rand(1, 3)).toFixed(0) + 'deg',
  };
}

/**
 * 扔番茄：番茄落在 (--tx, --ty)（供 fxTomatoFly / 粒子 / 酱渍 / 红闪共用），
 * --rot 系列是旋转关键帧的三个节点（避免在 CSS 里做 var() 乘法），
 * --fx-from-x / --fx-from-y 是抛物线起点的屏外偏移。
 */
function buildTomatoStyle(): CSSProperties {
  const fromLeft = Math.random() < 0.5;
  const spin = (fromLeft ? 1 : -1) * rand(420, 640);
  return {
    '--fx-dur': INTERACTION_FX_MS.tomato + 'ms',
    '--fx-hit': HIT_MS.tomato + 'ms',
    '--tx': pct(rand(36, 62)),
    '--ty': pct(rand(28, 42)),
    '--rot': spin.toFixed(0) + 'deg',
    '--rot-a': (spin * 0.48).toFixed(0) + 'deg',
    '--rot-hit': (spin * 0.78).toFixed(0) + 'deg',
    '--fx-from-x': (fromLeft ? -1 : 1) * rand(46, 66) + 'vw',
    '--fx-from-mid-x': (fromLeft ? -1 : 1) * rand(8, 16) + 'vw',
    '--fx-from-y': vh(rand(34, 50)),
    '--fx-flash-dur': '520ms',
  };
}

/** 倒咖啡：杯子从 (--fx-x, 顶部) 倾倒，液柱落到底部水滩；命中时刻 = 水滩成形 */
function buildCoffeeStyle(): CSSProperties {
  return {
    '--fx-dur': INTERACTION_FX_MS.coffee + 'ms',
    '--fx-hit': HIT_MS.coffee + 'ms',
    '--fx-x': pct(rand(42, 58)),
    '--fx-flash-dur': '700ms',
  };
}

/** 番茄爆汁粒子：9~12 块，先向外上方抛起（--pu）再落（--py），各自大小/颜色/延迟不同 */
function buildJuiceBits(): CSSProperties[] {
  const count = 9 + Math.floor(Math.random() * 4);
  const bits: CSSProperties[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + rand(-0.22, 0.22);
    const dir = Math.cos(angle) >= 0 ? 1 : -1;
    const spread = rand(30, 100) * Math.abs(Math.cos(angle)) + rand(6, 18);
    bits.push({
      '--px': px(dir * spread),
      '--pu': px(-rand(26, 58)),
      '--py': px(rand(26, 74)),
      '--pr': rand(-320, 320).toFixed(0) + 'deg',
      '--ps': rand(6, 14).toFixed(1) + 'px',
      '--pd': rand(0, 70).toFixed(0) + 'ms',
      '--pc': JUICE_COLORS[i % JUICE_COLORS.length],
    });
  }
  return bits;
}

/** 咖啡飞溅液滴：7~9 滴，从水滩上沿向外抛起再砸回水面 */
function buildCoffeeDrops(): CSSProperties[] {
  const count = 7 + Math.floor(Math.random() * 3);
  const drops: CSSProperties[] = [];
  for (let i = 0; i < count; i += 1) {
    drops.push({
      '--px': px(rand(-62, 62)),
      '--py': vh(rand(0.5, 6.5)),
      '--ps': rand(6, 12).toFixed(1) + 'px',
      '--pd': rand(0, 170).toFixed(0) + 'ms',
    });
  }
  return drops;
}

/* ==================== 摇屏 ==================== */

function shake(): void {
  const body = document.body;
  if (!body) {
    return;
  }
  window.clearTimeout(shakeOffTimer);
  // 先摘再挂（读一次 offsetWidth 强制回流）：连续两次戳一戳也能重播摇晃
  body.classList.remove('is-fx-shake');
  void body.offsetWidth;
  body.classList.add('is-fx-shake');
  shakeOffTimer = window.setTimeout(() => {
    body.classList.remove('is-fx-shake');
  }, SHAKE_MS);
}

/* ==================== 播放 / 清理 ==================== */

function removeEffect(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  effects.value = effects.value.filter((effect) => effect.id !== id);
}

function play(kind: InteractKind): void {
  try {
    const style =
      kind === 'poke' ? buildPokeStyle() : kind === 'tomato' ? buildTomatoStyle() : buildCoffeeStyle();
    const bits = kind === 'tomato' ? buildJuiceBits() : kind === 'coffee' ? buildCoffeeDrops() : [];
    seq += 1;
    const id = seq;
    effects.value = [...effects.value, { id, kind, style, bits }];
    timers.set(
      id,
      window.setTimeout(() => {
        removeEffect(id);
      }, INTERACTION_FX_MS[kind]),
    );
    if (kind === 'poke') {
      window.clearTimeout(shakeDelayTimer);
      shakeDelayTimer = window.setTimeout(() => {
        try {
          shake();
        } catch {
          /* 摇屏失败不影响戳一戳的其余表现 */
        }
      }, HIT_MS.poke);
    }
  } catch {
    /* 特效只是彩头，任何异常都不能影响互动本身 */
  }
}

function clear(): void {
  timers.forEach((timer) => {
    window.clearTimeout(timer);
  });
  timers.clear();
  window.clearTimeout(shakeDelayTimer);
  window.clearTimeout(shakeOffTimer);
  document.body?.classList.remove('is-fx-shake');
  effects.value = [];
}

const api: InteractionFxApi = { effects, play, clear };

/** 唯一出口：全局共享同一份特效列表 */
export function useInteractionFx(): InteractionFxApi {
  return api;
}
