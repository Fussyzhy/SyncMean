/**
 * 纯展示 / 数据整形工具（旧 public/app.js 中同名 helper 的 TypeScript 移植）。
 *
 * 只做纯函数，不碰 DOM、不碰状态：组件与组合式函数都可以安全复用。
 * 所有 v2 / v2.1 的新字段在旧后端并行开发期可能缺失，因此这里对空值一律兜底。
 */

import type {
  AgreePair,
  Basis,
  HistoryItem,
  PublicPlayer,
  PublicRoomState,
  Result,
  Seat,
  WinBy,
  Words,
} from '@shared/protocol';

export function normalizeCode(value: unknown): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

export function truncate12(value: unknown): string {
  const chars = Array.from(String(value || ''));
  return chars.slice(0, 12).join('');
}

export function findMe(state: PublicRoomState | null | undefined): PublicPlayer | null {
  if (!state || !Array.isArray(state.players)) return null;
  return state.players.find((p) => p && p.isYou) || null;
}

export function findPlayer(
  state: PublicRoomState | null | undefined,
  seat: Seat,
): PublicPlayer | null {
  if (!state || !Array.isArray(state.players)) return null;
  return state.players.find((p) => p && p.seat === seat) || null;
}

export function lastHistoryItem(state: PublicRoomState | null | undefined): HistoryItem | null {
  const list = state && Array.isArray(state.history) ? state.history : [];
  return list.length ? list[list.length - 1] : null;
}

/** 第 1 轮的联想依据提示语 */
export function basisPhrase(basis: Basis | null | undefined): string {
  if (!basis || !basis.a || !basis.b) return '随便想一个词';
  return '「' + basis.a + '」×「' + basis.b + '」';
}

/** 按 round 去重（后到的覆盖先到的），保持首次出现的顺序 —— 结算/导出用 */
export function dedupeHistory(history: readonly HistoryItem[] | null | undefined): HistoryItem[] {
  const items = Array.isArray(history) ? history : [];
  const byRound = new Map<number, HistoryItem>();
  const order: number[] = [];
  items.forEach((item) => {
    if (!item || typeof item.round !== 'number') return;
    if (!byRound.has(item.round)) order.push(item.round);
    byRound.set(item.round, item);
  });
  const out: HistoryItem[] = [];
  order.forEach((round) => {
    const item = byRound.get(round);
    if (item) out.push(item);
  });
  return out;
}

/** 按 round 去重且倒序（新的一轮在前）—— 对局页「已玩轮次」用 */
export function uniqueHistoryDesc(history: readonly HistoryItem[] | null | undefined): HistoryItem[] {
  const items = Array.isArray(history) ? history : [];
  const seen = new Set<number>();
  const out: HistoryItem[] = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || typeof item.round !== 'number' || seen.has(item.round)) continue;
    seen.add(item.round);
    out.push(item);
  }
  return out;
}

/** 结算行与 history 项的公共形状（旧实现对两者用同一套判定） */
export interface RowLike {
  round: number;
  basis: Basis | null;
  words: Words;
  isWin: boolean;
  agree: AgreePair | null;
  winBy: WinBy | null;
}

/** 单轮的通关方式：显式 winBy 优先，再认双票 agree，最后退到「相同通关」 */
export function rowWinBy(item: RowLike | null | undefined): WinBy | null {
  if (!item) return null;
  if (item.winBy === 'agree' || item.winBy === 'same') return item.winBy;
  if (item.agree && item.agree.a === true && item.agree.b === true) return 'agree';
  if (item.isWin) return 'same';
  return null;
}

export function flagText(winBy: WinBy | null): string {
  if (winBy === 'agree') return '同意词通关';
  if (winBy === 'same') return '一模一样通关';
  return '继续联想';
}

export function winTitle(winBy: WinBy | null): string {
  if (winBy === 'agree') return '双方确认同意词，通关！';
  if (winBy === 'same') return '一模一样，通关！';
  return '本局结束';
}

/**
 * v2.1（PROTOCOL §5.3.1）：lobby 阶段里，对方是否还留在上一局的结算页。
 * 必须「真有快照挂着」+「对方 settleDismissed 严格 === false」两条同时成立才算锁。
 * settlePending 缺失 / 非 true 一律当作没有结算，绝不锁。
 */
export function opponentWatchingSettle(
  state: PublicRoomState | null | undefined,
  opponent: PublicPlayer | null | undefined,
): boolean {
  if (!state || state.phase !== 'lobby' || !opponent) return false;
  if (state.settlePending !== true) return false;
  return opponent.settleDismissed === false;
}

/** 两票齐（state 视角 / result 副本 / history 末项任一为真） */
function agreeBothTrue(state: PublicRoomState | null | undefined): boolean {
  if (!state) return false;
  const raw = state.agree;
  if (raw && raw.you && raw.opponent) return true;
  const sources: Array<Result | HistoryItem | null> = [state.result || null, lastHistoryItem(state)];
  for (const source of sources) {
    const agree = source && source.agree;
    if (agree && agree.a && agree.b) return true;
  }
  return false;
}

/**
 * 通关方式解析。winBy 可能暂时不下发：
 * 先认 agree 票齐，再认 winBy，最后退到「相同通关」。
 */
export function resolveWinBy(
  state: PublicRoomState | null | undefined,
  result: Result | null | undefined,
): WinBy | null {
  const sources: Array<Result | HistoryItem | null> = [
    result || null,
    state ? state.result : null,
    lastHistoryItem(state),
  ];
  for (const source of sources) {
    if (source && source.winBy === 'agree') return 'agree';
  }
  if (agreeBothTrue(state)) return 'agree';
  for (const source of sources) {
    if (source && source.winBy === 'same') return 'same';
  }
  for (const source of sources) {
    if (source && source.isWin) return 'same';
  }
  return null;
}

export function playerName(state: PublicRoomState | null | undefined, seat: Seat): string {
  const p = findPlayer(state, seat);
  if (p && p.name) return p.name;
  if (p && p.isYou && state && state.you && state.you.name) return state.you.name;
  return seat === 'a' ? '玩家 A' : '玩家 B';
}

function pad2(n: number): string {
  return (n < 10 ? '0' : '') + String(n);
}

/** 毫秒 → m:ss（向上取整到秒；不足 10 秒也补成 0:0X），用于「已等 m:ss」等待计时 */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const seconds = Math.ceil(safe / 1000);
  return Math.floor(seconds / 60) + ':' + pad2(seconds % 60);
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  if (!isFinite(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

/* ---------------- 结算 / 导出共用的数据模型 ---------------- */

export interface SettleRow {
  round: number;
  a: string;
  b: string;
  basisA: string;
  basisB: string;
  winBy: WinBy | null;
  flag: string;
}

export interface SettleModel {
  code: string;
  winBy: WinBy | null;
  title: string;
  flag: string;
  finalA: string;
  finalB: string;
  nameA: string;
  nameB: string;
  at: number;
  dateText: string;
  rows: SettleRow[];
  totalRounds: number;
  agreeRounds: number;
  sameRounds: number;
  fileName: string;
}

/**
 * 结算/导出共用的数据模型：只从 state.code / players / history / result / you 取，
 * 不新增后端字段。所有 v2 字段都可能是 undefined，统一在这里兜底成可显示的字符串。
 */
export function buildSettleModel(state: PublicRoomState, settleAt: number): SettleModel {
  const rows: RowLike[] = dedupeHistory(state.history);
  const result = state.result || null;
  const resultRound = result && typeof result.round === 'number' ? result.round : null;
  if (resultRound !== null && !rows.some((item) => item.round === resultRound)) {
    rows.push({
      round: resultRound,
      basis: state.basis || null,
      words: (result && result.words) || { a: '', b: '' },
      isWin: !!(result && result.isWin),
      agree: (result && result.agree) || null,
      winBy: (result && result.winBy) || null,
    });
  }
  rows.sort((x, y) => x.round - y.round);

  const winBy = resolveWinBy(state, result);
  const last = rows.length ? rows[rows.length - 1] : null;
  const words = (result && result.words) || (last && last.words) || null;
  const code = String(state.code || '----');

  const list: SettleRow[] = rows.map((item) => {
    const w = item.words || { a: '', b: '' };
    const basis = item.basis || null;
    const rowBy = rowWinBy(item);
    return {
      round: item.round,
      a: w.a || '—',
      b: w.b || '—',
      basisA: basis && basis.a ? basis.a : '',
      basisB: basis && basis.b ? basis.b : '',
      winBy: rowBy,
      flag: flagText(rowBy),
    };
  });

  let agreeRounds = 0;
  let sameRounds = 0;
  list.forEach((row) => {
    if (row.winBy === 'agree') agreeRounds += 1;
    else if (row.winBy === 'same') sameRounds += 1;
  });

  const at = settleAt || Date.now();

  return {
    code,
    winBy,
    title: winTitle(winBy),
    flag: winBy ? '通关' : '本局结束',
    finalA: words && words.a ? words.a : '—',
    finalB: words && words.b ? words.b : '—',
    nameA: playerName(state, 'a'),
    nameB: playerName(state, 'b'),
    at,
    dateText: formatDateTime(at),
    rows: list,
    totalRounds: list.length,
    agreeRounds,
    sameRounds,
    fileName: '同声传意-' + code.replace(/[^A-Za-z0-9]/g, '') + '.png',
  };
}
