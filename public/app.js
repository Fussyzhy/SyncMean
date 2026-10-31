/* ============================================================
   同声传意 · 双人联机 —— 前端逻辑
   所有对局信息都以服务端 room:state 为唯一渲染依据。
   v2：新增同意词投票（round:agree）、结算视图与 Canvas 图片导出，
       并按 PROTOCOL §12 统一管理按钮 loading 态。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  // 存储键前缀沿用历史值，改了会让老用户已存的昵称/会话失效（非用户可见文案）
  const KEY_NICK = '321:nick';
  const KEY_TOKEN = '321:token';
  const KEY_SESSION = '321:session';
  const KEY_SOUND = '321:sound';

  const SUBMIT_MS = 60000; // 与 PROTOCOL §3 SUBMIT_MS 一致，仅用于进度条比例
  const COUNTDOWN_FALLBACK_MS = 3000;
  const TICK_MS = 100;
  const ACK_TIMEOUT_MS = 10000;
  const POSTER_W = 1080; // PROTOCOL §11：逻辑宽度 1080
  const POSTER_DPR_MIN = 1;
  const POSTER_DPR_MAX = 3;
  const POSTER_FONT =
    '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei",sans-serif';

  // v2.1 §5.3.1：对方还留在结算页时，准备页的统一提示（tip 与按钮 tooltip 共用同一句）
  const SETTLE_WATCH_TIP = '对方还在看上一局的结算，等你俩都点『再来一局』才能开始～';

  const $ = (id) => document.getElementById(id);

  /* ---------------- DOM ---------------- */
  const dom = {
    views: {
      home: $('view-home'),
      room: $('view-room'),
      game: $('view-game'),
      settle: $('view-settle')
    },
    nickname: $('nickname-input'),
    create: $('btn-create'),
    code: $('code-input'),
    join: $('btn-join'),
    roomCode: $('room-code'),
    copy: $('btn-copy'),
    ready: $('btn-ready'),
    leaveRoom: $('btn-leave-room'),
    players: $('players'),
    roomTip: $('room-tip'),
    roomPhase: $('room-phase'),
    roundLabel: $('game-round'),
    gameCode: $('game-code'),
    exit: $('btn-exit'),
    basis: $('basis'),
    play: $('play-panel'),
    word: $('word-input'),
    submit: $('btn-submit'),
    waiting: $('waiting-hint'),
    opponentHint: $('opponent-hint'),
    timer: $('timer'),
    timerBar: $('timer-bar'),
    timerText: $('timer-text'),
    revealPanel: $('reveal-panel'),
    revealA: $('reveal-a'),
    revealB: $('reveal-b'),
    verdict: $('reveal-verdict'),
    nextHint: $('next-hint'),
    next: $('btn-next'),
    // v2 同意词投票
    agreeRow: $('agree-row'),
    agree: $('btn-agree'),
    agreeHint: $('agree-hint'),
    agreeOpponent: $('agree-opponent'),
    // v2 结算视图（#btn-restart / #btn-leave-win 已从旧 #win-actions 移到这里，id 不变）
    restart: $('btn-restart'),
    leaveWin: $('btn-leave-win'),
    settleFlag: $('settle-flag'),
    settleTitle: $('settle-title'),
    settleFinal: $('settle-final'),
    settleMeta: $('settle-meta'),
    settleRounds: $('settle-rounds'),
    settleStats: $('settle-stats'),
    export: $('btn-export'),
    exportCopy: $('btn-export-copy'),
    exportPreview: $('export-preview'),
    history: $('history'),
    toast: $('toast'),
    overlay: $('countdown-overlay'),
    overlayNum: $('countdown-number'),
    overlaySub: $('countdown-sub'),
    sound: $('btn-sound'),
    net: $('net-banner'),
    confetti: $('confetti')
  };

  /* ---------------- 应用状态 ---------------- */
  const app = {
    socket: null,
    token: '',
    session: null, // {code, token, name, seat}
    state: null, // 最新 PublicRoomState
    view: 'home',
    pendingJoin: false,
    pendingCreate: false,
    leaving: false,
    ignoreState: false,
    readyBusy: false,
    submitBusy: false,
    restartBusy: false,
    nextBusy: false,
    agreeBusy: false,
    exportBusy: false,
    agreeAck: null, // {round, you, opponent}：后端 agree 字段缺失时的兜底（来自 round:agree 的 ack）
    settleAt: 0, // 首次进入结算的本地时间，导出与展示用同一个时刻
    exportBlobUrl: '',
    localSubmitted: false,
    opponentSubmitted: false,
    lastRound: 0,
    lastReveal: null,
    revealRound: 0,
    winRound: 0,
    countdown: null, // {round, endsAt, shown}
    countdownDoneRound: 0,
    openRound: 0, // round:open 的兜底，state 追上后即失效
    openDeadline: 0,
    soundOn: true
  };

  let audioCtx = null;
  let toastTimer = 0;

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(node, text) {
    if (!node) return;
    const next = String(text);
    if (node.textContent !== next) node.textContent = next;
  }

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      if (value === null || value === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(value));
    } catch (err) {
      /* 隐私模式下 localStorage 不可用，忽略即可 */
    }
  }

  /*
   * 身份 token 与对局会话必须按「标签页」隔离，而不是整个浏览器共享：
   * 否则同一个浏览器开两个标签页自己试玩时，第二个标签会读到第一个的 token，
   * 被服务端当成同一玩家的断线重连，把对方顶掉（REPLACED）。
   * sessionStorage 恰好是「每标签独立 + 刷新仍在」，关闭标签即清理。
   */
  function readLive(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeLive(key, value) {
    try {
      if (value === null || value === undefined) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, String(value));
    } catch (err) {
      /* 隐私模式下 sessionStorage 不可用，忽略即可 */
    }
  }

  function makeToken() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (err) {
      /* 继续走降级方案 */
    }
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const buf = new Uint32Array(4);
        window.crypto.getRandomValues(buf);
        return 't' + Date.now().toString(36) + '-' + Array.prototype.join.call(buf, '-');
      }
    } catch (err) {
      /* 继续走降级方案 */
    }
    return 't' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function readSession() {
    const raw = readLive(KEY_SESSION);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.code !== 'string' || !obj.code) return null;
      return {
        code: obj.code,
        token: obj.token || '',
        name: obj.name || '',
        seat: obj.seat || ''
      };
    } catch (err) {
      return null;
    }
  }

  function saveSession() {
    writeLive(KEY_SESSION, app.session ? JSON.stringify(app.session) : null);
  }

  function clearSession() {
    app.session = null;
    writeLive(KEY_SESSION, null);
  }

  function normalizeCode(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 4);
  }

  function truncate12(value) {
    const chars = Array.from(String(value || ''));
    return chars.slice(0, 12).join('');
  }

  function findMe(state) {
    if (!state || !Array.isArray(state.players)) return null;
    return state.players.find((p) => p && p.isYou) || null;
  }

  function findPlayer(state, seat) {
    if (!state || !Array.isArray(state.players)) return null;
    return state.players.find((p) => p && p.seat === seat) || null;
  }

  function basisPhrase(basis) {
    if (!basis || !basis.a || !basis.b) return '随便想一个词';
    return '「' + basis.a + '」×「' + basis.b + '」';
  }

  function isSubmittedYou(state) {
    if (!state) return false;
    return !!(state.submitted && state.submitted.you) || app.localSubmitted;
  }

  /* ---------------- v2：座位视角 / 同意词 / 通关方式（全部空值兜底） ---------------- */
  function mySeat(state) {
    const seat =
      (state && state.you && state.you.seat) ||
      (app.session && app.session.seat) ||
      (findMe(state) && findMe(state).seat) ||
      '';
    return seat === 'b' ? 'b' : 'a';
  }

  function otherSeat(seat) {
    return seat === 'a' ? 'b' : 'a';
  }

  /*
   * 本轮同意词投票视角。以后端 state.agree 为唯一事实来源；
   * 后端还没下发该字段时（并行开发期），退到 round:agree 的 ack 载荷，
   * 再退不到就当作都没投——绝不因为 undefined 抛错。
   */
  function agreeView(state) {
    const raw = state && state.agree;
    if (raw && typeof raw === 'object') {
      return { you: !!raw.you, opponent: !!raw.opponent };
    }
    const ack = app.agreeAck;
    if (ack && state && Number(ack.round) === Number(state.round)) {
      return { you: !!ack.you, opponent: !!ack.opponent };
    }
    return { you: false, opponent: false };
  }

  function agreeBothTrue(state) {
    const view = agreeView(state);
    if (view.you && view.opponent) return true;
    const src = [state && state.result, lastHistoryItem(state)];
    for (let i = 0; i < src.length; i += 1) {
      const ag = src[i] && src[i].agree;
      if (ag && ag.a && ag.b) return true;
    }
    return false;
  }

  /* 本轮是否已因投票取消自动推进：revealFrozen 优先，缺失时按 deadline 兜底 */
  function isRevealFrozen(state) {
    if (!state || state.phase !== 'reveal') return false;
    if (state.revealFrozen === true) return true;
    if (state.revealFrozen === false) return false;
    return state.deadline === null || state.deadline === undefined;
  }

  /*
   * v2.1（PROTOCOL §5.3.1）：lobby 阶段里，对方是否还留在上一局的结算页。
   * 必须「真有快照挂着」+「对方 settleDismissed 严格 === false」两条同时成立才算锁。
   * 单看 settleDismissed 是错的：它在新房里初值就是 false，会把双方准备按钮永久锁死。
   * settlePending 缺失 / 非 true（老后端还没下发）一律当作没有结算，绝不锁。
   */
  function opponentWatchingSettle(state, opponent) {
    if (!state || state.phase !== 'lobby' || !opponent) return false;
    if (state.settlePending !== true) return false;
    return opponent.settleDismissed === false;
  }

  /* winBy 可能暂时不下发：先认 agree 票齐，再认 winBy，最后退到「相同通关」 */
  function resolveWinBy(state, result) {
    const sources = [result, state && state.result, lastHistoryItem(state)];
    for (let i = 0; i < sources.length; i += 1) {
      if (sources[i] && sources[i].winBy === 'agree') return 'agree';
    }
    if (agreeBothTrue(state)) return 'agree';
    for (let i = 0; i < sources.length; i += 1) {
      if (sources[i] && sources[i].winBy === 'same') return 'same';
    }
    for (let i = 0; i < sources.length; i += 1) {
      if (sources[i] && sources[i].isWin) return 'same';
    }
    return null;
  }

  function winTitle(winBy) {
    if (winBy === 'agree') return '双方确认同意词，通关！';
    if (winBy === 'same') return '一模一样，通关！';
    return '本局结束';
  }

  function lastHistoryItem(state) {
    const list = state && Array.isArray(state.history) ? state.history : [];
    return list.length ? list[list.length - 1] : null;
  }

  /* 按 round 去重，倒序优先保留后到的（agree 通关会更新同一轮的 isWin/winBy） */
  function dedupeHistory(history) {
    const items = Array.isArray(history) ? history : [];
    const byRound = {};
    const order = [];
    items.forEach((item) => {
      if (!item || typeof item.round !== 'number') return;
      if (!byRound[item.round]) order.push(item.round);
      byRound[item.round] = item;
    });
    return order.map((round) => byRound[round]);
  }

  /* ---------------- 提示条 ---------------- */
  function toast(message, kind) {
    if (!message || !dom.toast) return;
    dom.toast.textContent = String(message);
    dom.toast.className = 'toast is-on' + (kind ? ' toast--' + kind : '');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      dom.toast.classList.remove('is-on');
    }, 2800);
  }

  function setNet(text) {
    if (!dom.net) return;
    if (!text) {
      dom.net.classList.remove('is-on');
      dom.net.textContent = '';
      return;
    }
    dom.net.textContent = text;
    dom.net.classList.add('is-on');
  }

  function setBusy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle('is-busy', !!on);
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  /*
   * PROTOCOL §12：is-busy 只能由「当前真实忙态」决定，而且必须在渲染函数里重新赋值。
   * 只靠请求回调移除是不够的——ack 到达时服务端往往已经广播了新 phase，渲染走了别的分支，
   * 按钮再也没被碰过，is-busy 就永久残留（CSS 里 color:transparent，看起来「没文字 + 一直转圈」）。
   * paintBusy 不碰 disabled，disabled 继续由各渲染函数按相位判定。
   */
  function paintBusy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-busy', !!on);
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  // 每次渲染都按真实忙态 + 当前相位重刷所有 loading 按钮（相位不匹配说明在途请求已作废）
  function syncLoading(state) {
    const phase = (state && state.phase) || '';
    paintBusy(dom.ready, !!app.readyBusy && phase === 'lobby');
    paintBusy(dom.submit, !!app.submitBusy && (phase === 'countdown' || phase === 'submitting'));
    paintBusy(dom.agree, !!app.agreeBusy && phase === 'reveal');
    paintBusy(dom.next, !!app.nextBusy && phase === 'reveal');
    paintBusy(dom.restart, !!app.restartBusy && phase === 'won');
    paintBusy(dom.export, !!app.exportBusy && phase === 'won');
    paintBusy(dom.exportCopy, !!app.exportBusy && phase === 'won');
    paintBusy(dom.leaveRoom, false);
    paintBusy(dom.exit, false);
  }

  // 回首页 / 离开房间 / aborted / 断线重连：在途请求全部作废，loading 一律归位
  function resetAllLoading() {
    app.readyBusy = false;
    app.submitBusy = false;
    app.nextBusy = false;
    app.restartBusy = false;
    app.agreeBusy = false;
    app.exportBusy = false;
    [
      dom.ready,
      dom.submit,
      dom.agree,
      dom.next,
      dom.restart,
      dom.leaveRoom,
      dom.exit,
      dom.leaveWin,
      dom.export,
      dom.exportCopy
    ].forEach((btn) => paintBusy(btn, false));
  }

  /* ---------------- 音效（失败绝不抛出） ---------------- */
  function getCtx() {
    if (!app.soundOn) return null;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') {
        const p = audioCtx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      return audioCtx;
    } catch (err) {
      return null;
    }
  }

  function tone(freq, dur, type, peak, delay) {
    try {
      const ctx = getCtx();
      if (!ctx) return;
      const when = ctx.currentTime + (delay || 0);
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
    } catch (err) {
      /* 音效失败无所谓 */
    }
  }

  function soundTick(n) {
    tone(n <= 1 ? 880 : 620, 0.1, 'sine', 0.05);
  }

  function soundGo() {
    tone(1046, 0.16, 'triangle', 0.05);
  }

  function soundReveal() {
    tone(520, 0.1, 'sine', 0.04);
    tone(660, 0.12, 'sine', 0.038, 0.1);
  }

  function soundSubmit() {
    tone(780, 0.06, 'sine', 0.035);
  }

  function soundWin() {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.05, i * 0.11));
  }

  function applySoundLabel() {
    if (!dom.sound) return;
    dom.sound.textContent = app.soundOn ? '🔊' : '🔇';
    dom.sound.setAttribute('aria-pressed', app.soundOn ? 'true' : 'false');
    dom.sound.setAttribute('aria-label', app.soundOn ? '关闭音效' : '打开音效');
  }

  function onSoundToggle() {
    app.soundOn = !app.soundOn;
    writeStore(KEY_SOUND, app.soundOn ? '1' : '0');
    applySoundLabel();
    if (app.soundOn) {
      getCtx();
      tone(880, 0.08, 'sine', 0.04);
    }
  }

  /* ---------------- 视图 ---------------- */
  function showView(name) {
    const changed = app.view !== name;
    app.view = name;
    document.body.dataset.view = name;
    Object.keys(dom.views).forEach((key) => {
      const node = dom.views[key];
      if (!node) return;
      const on = key === name;
      node.classList.toggle('view--active', on);
      node.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    if (changed) {
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        window.scrollTo(0, 0);
      }
    }
  }

  /* ---------------- 网络请求封装 ---------------- */
  function emitAck(event, payload, cb) {
    const socket = app.socket;
    const done = typeof cb === 'function' ? cb : () => {};
    if (!socket || !socket.connected) {
      done({ ok: false, error: 'OFFLINE', message: '还没连上服务器，稍等一下再试' });
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      done({ ok: false, error: 'TIMEOUT', message: '服务器没回应，稍后再试' });
    }, ACK_TIMEOUT_MS);
    try {
      socket.emit(event, payload, (res) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        done(res && typeof res === 'object' ? res : { ok: false, error: 'BAD_ACK', message: '服务器返回异常' });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      done({ ok: false, error: 'EMIT_FAILED', message: '发送失败，再试一次' });
    }
  }

  function readName() {
    let name = String(dom.nickname.value || '').trim();
    name = truncate12(name);
    if (name !== dom.nickname.value) dom.nickname.value = name;
    if (!name) {
      toast('先给自己起个昵称吧～');
      try {
        dom.nickname.focus();
      } catch (err) {
        /* ignore */
      }
      return '';
    }
    writeStore(KEY_NICK, name);
    return name;
  }

  /* ---------------- 房间：创建 / 加入 / 恢复 ---------------- */
  function onCreate() {
    if (app.pendingCreate) return;
    const name = readName();
    if (!name) return;
    app.pendingCreate = true;
    app.ignoreState = false;
    setBusy(dom.create, true);
    emitAck('room:create', { name: name, token: app.token }, (res) => {
      app.pendingCreate = false;
      setBusy(dom.create, false);
      if (!res.ok) {
        toast(res.message || '建房失败了，再试一次');
        return;
      }
      app.leaving = false;
      app.session = {
        code: res.code,
        token: res.token || app.token,
        name: name,
        seat: res.seat || 'a'
      };
      saveSession();
      // 服务器可能先广播 room:state 再回 ack，此时房间已经渲染好了
      if (!app.state || app.state.code !== res.code) {
        app.state = null;
        showView('room');
        renderPendingRoom();
      }
      toast('房间建好了，把码发给朋友～');
    });
  }

  function onJoin() {
    const name = readName();
    if (!name) return;
    const code = normalizeCode(dom.code.value);
    dom.code.value = code;
    if (code.length !== 4) {
      toast('房间码是 4 位哦');
      try {
        dom.code.focus();
      } catch (err) {
        /* ignore */
      }
      return;
    }
    app.ignoreState = false;
    requestJoin({ code: code, name: name, token: app.token, restore: false });
  }

  function requestJoin(opts) {
    if (app.pendingJoin) return;
    app.pendingJoin = true;
    setBusy(dom.join, true);
    emitAck('room:join', { code: opts.code, name: opts.name, token: opts.token }, (res) => {
      app.pendingJoin = false;
      setBusy(dom.join, false);
      if (!res || !res.ok) {
        if (opts.restore) {
          clearSession();
          app.state = null;
          showView('home');
          toast((res && res.message) || '之前的房间已经不在了，回首页重新来吧');
          return;
        }
        toast((res && res.message) || '加入失败，再试一次');
        return;
      }
      app.ignoreState = false;
      app.leaving = false;
      app.session = {
        code: res.code || opts.code,
        token: res.token || opts.token,
        name: opts.name,
        seat: res.seat || 'b'
      };
      saveSession();
      if (res.state) render(res.state);
      if (opts.restore) toast('欢迎回来，继续吧');
      else toast('加入成功，等人齐就开始');
    });
  }

  function tryRestore() {
    const session = app.session;
    if (!session || !session.code) return;
    if (app.pendingJoin) return;
    requestJoin({
      code: session.code,
      name: session.name || readStore(KEY_NICK) || '玩家',
      token: session.token || app.token,
      restore: true
    });
  }

  function leaveNow(message) {
    if (app.leaving) return;
    app.leaving = true;
    emitAck('room:leave', {}, () => {});
    teardown(message || '已离开房间');
  }

  function teardown(message) {
    clearSession();
    app.ignoreState = true;
    app.state = null;
    app.localSubmitted = false;
    app.opponentSubmitted = false;
    app.lastRound = 0;
    app.lastReveal = null;
    app.revealRound = 0;
    app.winRound = 0;
    app.countdownDoneRound = 0;
    app.openRound = 0;
    app.openDeadline = 0;
    app.agreeAck = null;
    app.settleAt = 0;
    resetAllLoading();
    app.leaving = false;
    resetCountdown();
    dom.word.value = '';
    dom.revealPanel.classList.remove('is-on', 'is-win');
    dom.verdict.classList.remove('verdict--pop');
    dom.play.classList.remove('is-hidden');
    hideAgreeRow();
    clearSettleView();
    if (dom.confetti) dom.confetti.replaceChildren();
    renderHistory([]);
    setBusy(dom.leaveRoom, false);
    setBusy(dom.word, false);
    setBusy(dom.submit, false);
    showView('home');
    if (message) toast(message);
  }

  /* ---------------- 准备 / 提交 / 下一轮 / 重开 ---------------- */
  function onReady() {
    if (!app.state || app.state.phase !== 'lobby' || app.readyBusy) return;
    const players = Array.isArray(app.state.players) ? app.state.players : [];
    const opponent = players.find((p) => p && !p.isYou) || null;
    // v2.1 §5.3.1：对方还在结算页时服务端会硬拒 player:ready，这里直接不发起请求
    if (opponentWatchingSettle(app.state, opponent)) {
      toast(SETTLE_WATCH_TIP);
      return;
    }
    const me = findMe(app.state);
    const nextReady = !(me && me.ready);
    app.readyBusy = true;
    setBusy(dom.ready, true);
    emitAck('player:ready', { ready: nextReady }, (res) => {
      app.readyBusy = false;
      /*
       * bug 4 的根因：ack 到达时服务端可能已经广播了新 phase（lobby → countdown），
       * 于是 render 走 game 分支，再也没碰过 #btn-ready，is-busy 就永久残留。
       * 所以这里无论成功失败都必须先把 loading 归位，再决定渲染哪一屏。
       */
      setBusy(dom.ready, false);
      if (!res || !res.ok) toast((res && res.message) || '准备状态没同步上，再点一次');
      if (app.state) render(app.state);
    });
  }

  function submitWord() {
    const state = app.state;
    if (!state) return;
    const opened =
      state.phase === 'submitting' || (state.phase === 'countdown' && app.openRound === Number(state.round));
    if (!opened) return;
    if (isSubmittedYou(state) || app.submitBusy) return;
    let word = truncate12(String(dom.word.value || '').trim());
    if (!word) {
      toast('先想一个词再提交呀');
      try {
        dom.word.focus();
      } catch (err) {
        /* ignore */
      }
      return;
    }
    app.submitBusy = true;
    setBusy(dom.submit, true);
    emitAck('round:submit', { word: word }, (res) => {
      app.submitBusy = false;
      setBusy(dom.submit, false); // §12：成功失败都归位，不依赖后续渲染分支
      if (!res || !res.ok) {
        toast((res && res.message) || '提交失败了，再试一次');
        if (app.state) render(app.state);
        return;
      }
      app.localSubmitted = true;
      soundSubmit();
      if (app.state) render(app.state);
    });
  }

  function onNext() {
    if (app.nextBusy) return;
    app.nextBusy = true;
    setBusy(dom.next, true);
    emitAck('round:next', {}, (res) => {
      app.nextBusy = false;
      setBusy(dom.next, false); // §12：成功失败都归位
      if (!res || !res.ok) toast((res && res.message) || '现在还不能跳到下一轮');
      if (app.state) render(app.state);
    });
  }

  /* ---------------- v2：同意词投票 ---------------- */
  function onAgree() {
    const state = app.state;
    if (!state || state.phase !== 'reveal' || app.agreeBusy) return;
    const view = agreeView(state);
    const next = !view.you;
    app.agreeBusy = true;
    setBusy(dom.agree, true);
    emitAck('round:agree', { agree: next }, (res) => {
      app.agreeBusy = false;
      setBusy(dom.agree, false); // §12：成功失败都归位
      if (!res || !res.ok) {
        toast((res && res.message) || '同意词没投出去，再点一次试试');
        if (app.state) render(app.state);
        return;
      }
      // 兜底：并行开发期后端可能还没下发 state.agree，就用 ack 的 agree:{a,b}
      const ackAgree = res.agree && typeof res.agree === 'object' ? res.agree : null;
      if (ackAgree) {
        const mine = mySeat(state);
        app.agreeAck = {
          round: Number(state.round) || 0,
          you: !!ackAgree[mine],
          opponent: !!ackAgree[otherSeat(mine)]
        };
      }
      if (app.state) render(app.state);
    });
  }

  function onRestart() {
    if (app.restartBusy) return;
    app.restartBusy = true;
    setBusy(dom.restart, true);
    emitAck('game:restart', {}, (res) => {
      app.restartBusy = false;
      setBusy(dom.restart, false); // §12：成功失败都归位
      if (!res || !res.ok) {
        toast((res && res.message) || '重开失败了，再试一次');
        return;
      }
      // 回到 lobby 前，把每一颗按钮的 loading 都归位（ready / submit / next / agree / 导出 / 离开）
      resetAllLoading();
      app.localSubmitted = false;
      app.opponentSubmitted = false;
      app.revealRound = 0;
      app.winRound = 0;
      app.lastReveal = null;
      app.agreeAck = null;
      app.settleAt = 0;
      dom.revealPanel.classList.remove('is-on', 'is-win');
      dom.verdict.classList.remove('verdict--pop');
      hideAgreeRow();
      clearSettleView();
      if (dom.confetti) dom.confetti.replaceChildren();
      toast('新的一局，准备好就开始！');
      if (app.state) render(app.state);
    });
  }

  /* ---------------- 复制邀请链接 ---------------- */
  function fallbackCopy(text) {
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
    } catch (err) {
      ok = false;
    }
    try {
      document.body.removeChild(area);
    } catch (err) {
      /* ignore */
    }
    return ok;
  }

  function copyText(text) {
    return new Promise((resolve) => {
      const fallback = () => resolve(fallbackCopy(text));
      try {
        if (
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function' &&
          window.isSecureContext !== false
        ) {
          navigator.clipboard.writeText(text).then(
            () => resolve(true),
            () => fallback()
          );
          return;
        }
      } catch (err) {
        /* 走降级 */
      }
      fallback();
    });
  }

  function onCopy() {
    const code =
      (app.state && app.state.code) ||
      (app.session && app.session.code) ||
      dom.roomCode.textContent.trim();
    if (!code || code === '----') {
      toast('房间码还没出来，稍等一下');
      return;
    }
    const link = window.location.origin + '/?room=' + encodeURIComponent(code);
    copyText(link).then((ok) => {
      toast(ok ? '邀请链接复制好啦，发给朋友吧' : '复制没成功，手动把房间码发过去吧');
    });
  }

  /* ---------------- 渲染：总入口 ---------------- */
  function syncSession(state) {
    if (!app.session) {
      app.session = {
        code: state.code,
        token: app.token,
        name: (state.you && state.you.name) || '',
        seat: (state.you && state.you.seat) || ''
      };
    }
    app.session.code = state.code || app.session.code;
    if (state.you && state.you.seat) app.session.seat = state.you.seat;
    if (state.you && state.you.name) app.session.name = state.you.name;
    if (!app.session.token) app.session.token = app.token;
    saveSession();
  }

  function render(state) {
    if (!state || typeof state !== 'object' || !state.code) return;
    if (app.ignoreState) return;

    const round = Number(state.round) || 1;
    if (round !== app.lastRound) {
      app.lastRound = round;
      app.localSubmitted = false;
      app.opponentSubmitted = false;
      app.lastReveal = null;
      app.revealRound = 0;
      app.winRound = 0;
      app.countdownDoneRound = 0;
      app.openRound = 0;
      app.openDeadline = 0;
      app.agreeAck = null; // 换轮 = 上一轮的投票兜底作废
      dom.word.value = '';
    }
    app.state = state;
    syncSession(state);
    syncLoading(state);

    if (state.phase === 'aborted') {
      onAborted();
      return;
    }

    if (state.phase === 'lobby') {
      app.localSubmitted = false;
      app.opponentSubmitted = false;
      app.lastReveal = null;
      app.revealRound = 0;
      app.winRound = 0;
      app.countdownDoneRound = 0;
      app.openRound = 0;
      app.openDeadline = 0;
      app.agreeAck = null;
      resetCountdown();
      dom.word.value = '';
      dom.revealPanel.classList.remove('is-on', 'is-win');
      dom.play.classList.remove('is-hidden');
      hideAgreeRow();
      clearSettleView();
      if (dom.confetti) dom.confetti.replaceChildren();
      renderHistory(state.history);
      showView('room');
      renderRoom(state);
      return;
    }

    if (state.phase === 'won') {
      // 先同步对局页内容（#reveal-verdict 文案、撒花、通关音效），再切到结算视图
      renderGame(state);
      showView('settle');
      renderSettle(state);
      return;
    }

    showView('game');
    renderGame(state);
  }

  function renderPendingRoom() {
    const session = app.session;
    if (!session) return;
    setText(dom.roomCode, session.code || '----');
    setText(dom.roomPhase, '1 / 2 人');
    dom.players.replaceChildren(
      playerCard('a', {
        seat: 'a',
        name: session.name,
        isHost: true,
        ready: false,
        connected: true,
        isYou: true
      }),
      playerCard('b', null)
    );
    setText(dom.roomTip, '房间建好了，把码发给朋友，等 TA 进来～');
    dom.ready.disabled = true;
    dom.ready.textContent = '准备';
    dom.ready.classList.add('btn--primary');
    dom.ready.classList.remove('btn--ghost');
    dom.ready.setAttribute('aria-pressed', 'false');
    // 别让上一次 lobby 留下的 v2.1 tooltip/aria-disabled 残留在这里
    dom.ready.removeAttribute('aria-disabled');
    dom.ready.removeAttribute('title');
    // §12：这条路径同样要显式清掉 is-busy（可能刚从别的房回来）
    paintBusy(dom.ready, false);
    paintBusy(dom.leaveRoom, false);
  }

  /* ---------------- 房间页 ---------------- */
  function renderRoom(state) {
    setText(dom.roomCode, state.code || '----');
    const players = Array.isArray(state.players) ? state.players : [];
    setText(dom.roomPhase, players.length + ' / 2 人');

    const bySeat = {};
    players.forEach((p) => {
      if (p && p.seat) bySeat[p.seat] = p;
    });
    dom.players.replaceChildren(playerCard('a', bySeat.a || null), playerCard('b', bySeat.b || null));

    const me = findMe(state);
    const opponent = players.find((p) => p && !p.isYou) || null;
    const ready = !!(me && me.ready);
    // v2.1（§5.3.1）：对方还停在上一局的结算页时，两人都无法 ready，本方准备按钮先锁住
    const watchingSettle = opponentWatchingSettle(state, opponent);

    dom.ready.textContent = ready ? '取消准备' : '准备';
    dom.ready.classList.toggle('btn--primary', !ready);
    dom.ready.classList.toggle('btn--ghost', ready);
    dom.ready.setAttribute('aria-pressed', ready ? 'true' : 'false');
    dom.ready.disabled = state.phase !== 'lobby' || app.readyBusy || watchingSettle;
    if (watchingSettle) {
      dom.ready.setAttribute('aria-disabled', 'true');
      dom.ready.title = SETTLE_WATCH_TIP;
    } else {
      dom.ready.removeAttribute('aria-disabled');
      dom.ready.removeAttribute('title');
    }
    // §12：按真实忙态重新赋值，不能只在 onReady 回调里移除
    paintBusy(dom.ready, !!app.readyBusy && state.phase === 'lobby');

    let tip;
    if (watchingSettle) {
      tip = SETTLE_WATCH_TIP;
    } else if (!opponent) {
      tip = '房间建好了，把码发给朋友，等 TA 进来～';
    } else if (!opponent.connected) {
      tip = '对方掉线了，房间还留着，等他回来就能继续。';
    } else if (ready && opponent.ready) {
      tip = '双方都准备好，马上开始！';
    } else if (ready) {
      tip = '你已经准备好啦，等对方点准备…';
    } else if (opponent.ready) {
      tip = '对方已经准备好了，就差你啦！';
    } else {
      tip = '两个人都点准备，就开始第 1 轮。';
    }
    setText(dom.roomTip, tip);
    dom.roomTip.classList.remove('tip--win');
  }

  function playerCard(seat, player) {
    const card = el('div', 'player player--' + seat);
    if (!player) {
      card.classList.add('player--empty');
      card.appendChild(el('div', 'player__avatar', '+'));
      const body = el('div', 'player__body');
      body.appendChild(el('div', 'player__name', '等待加入…'));
      body.appendChild(el('div', 'player__status', '把房间码发过去'));
      card.appendChild(body);
      return card;
    }
    if (player.isYou) card.classList.add('player--you');
    const initial = Array.from(String(player.name || '?'))[0] || '?';
    card.appendChild(el('div', 'player__avatar', initial));

    const body = el('div', 'player__body');
    body.appendChild(el('div', 'player__name', player.name || '玩家'));

    const badges = el('div', 'player__badges');
    if (player.isHost) badges.appendChild(el('span', 'badge badge--lime', '房主'));
    if (player.isYou) badges.appendChild(el('span', 'badge', '你'));
    badges.appendChild(
      el('span', 'badge ' + (player.ready ? 'badge--ready' : 'badge--muted'), player.ready ? '已准备' : '未准备')
    );
    body.appendChild(badges);

    const status = el('div', 'player__status');
    status.appendChild(el('span', 'dot' + (player.connected ? '' : ' dot--off')));
    status.appendChild(el('span', '', player.connected ? '在线' : '离线'));
    body.appendChild(status);

    card.appendChild(body);
    return card;
  }

  /* ---------------- 游戏页 ---------------- */
  function renderGame(state) {
    setText(dom.roundLabel, '第 ' + (state.round || 1) + ' 轮');
    setText(dom.gameCode, state.code || '----');

    renderBasis(state);

    const result = resultFor(state);
    const showResult = !!result && state.phase !== 'countdown' && state.phase !== 'lobby';

    renderPlay(state, showResult);
    renderReveal(state, result);
    renderHistory(state.history);

    if (state.phase === 'countdown') ensureCountdown(state);
  }

  function renderBasis(state) {
    const words = dom.basis.querySelector('.basis__words');
    const text = dom.basis.querySelector('.basis__text');
    const sub = dom.basis.querySelector('.basis__sub');
    const basis = state.basis;
    if (!basis || !basis.a || !basis.b) {
      setText(text, '第一轮：随便想一个词');
      setText(sub, '别想太多，想到什么写什么，看看你们能不能撞上。');
      if (words) {
        words.replaceChildren();
        words.classList.add('is-hidden');
      }
      return;
    }
    setText(text, '从这两个词出发，想到一起');
    setText(sub, '上一轮的两个词就是线索，把思路往中间靠一靠。');
    if (words) {
      words.classList.remove('is-hidden');
      words.replaceChildren(
        el('span', 'word-chip', basis.a),
        el('span', 'basis__x', '×'),
        el('span', 'word-chip', basis.b)
      );
    }
  }

  function renderPlay(state, showResult) {
    const submitted = isSubmittedYou(state);
    const phase = state.phase;
    const opened =
      phase === 'submitting' || (phase === 'countdown' && app.openRound === Number(state.round));
    const canType = opened && !submitted && !showResult;

    dom.play.classList.toggle('is-hidden', !!showResult);

    dom.word.disabled = !canType;
    dom.submit.disabled = !canType || app.submitBusy;
    dom.submit.textContent = submitted && opened ? '已提交' : '提交';
    // §12：统一走 paintBusy（原来 setBusy 与 classList 两套混用）
    paintBusy(dom.submit, !!app.submitBusy);

    if (submitted && opened) {
      dom.word.placeholder = '已经提交，等对方…';
    } else if (opened) {
      dom.word.placeholder = '写一个词，最多 12 个字';
    } else {
      dom.word.placeholder = '倒计时结束就能写啦';
    }

    dom.waiting.classList.toggle('is-on', opened && !showResult && submitted);
    const opponentDone = !!(state.submitted && state.submitted.opponent) || app.opponentSubmitted;
    dom.opponentHint.classList.toggle('is-on', opened && !showResult && !submitted && opponentDone);

    dom.timer.classList.toggle('is-hidden', !opened || !!showResult);
    if (!opened) {
      dom.timerBar.style.width = '100%';
      setText(dom.timerText, '60 秒');
    }

    if (opened && canType && document.activeElement !== dom.word) {
      try {
        if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) dom.word.focus();
      } catch (err) {
        /* ignore */
      }
    }
  }

  function resultFor(state) {
    if (state.result && state.result.words) return state.result;
    const ev = app.lastReveal;
    if (ev && ev.words && ev.round === state.round) {
      return {
        round: ev.round,
        words: ev.words,
        isWin: !!ev.isWin,
        timedOut: ev.timedOut || {},
        agree: ev.agree || null,
        winBy: ev.winBy || null
      };
    }
    return null;
  }

  function renderReveal(state, result) {
    const show = !!result && state.phase !== 'countdown' && state.phase !== 'lobby';
    const won = state.phase === 'won';

    dom.revealPanel.classList.toggle('is-on', show);
    dom.revealPanel.classList.toggle('is-win', !!(show && result && result.isWin));
    dom.next.classList.toggle('is-hidden', !show || won);
    dom.nextHint.classList.toggle('is-hidden', !show || won);

    if (!show) {
      app.revealRound = 0;
      app.winRound = 0;
      dom.verdict.classList.remove('verdict--pop');
      hideAgreeRow();
      return;
    }

    const round = Number(result.round) || Number(state.round) || 1;
    fillRevealCard(dom.revealA, 'a', result, state);
    fillRevealCard(dom.revealB, 'b', result, state);

    const winBy = resolveWinBy(state, result);
    if (result.isWin) {
      setText(dom.verdict, winBy === 'agree' ? '双方确认同意词，通关！🎉' : '一模一样，通关！🎉');
    }
    // 投票冻结后本轮不会再自动推进，文案必须改成手动继续（不能再写「下一轮马上开始…」）
    if (!won) setText(dom.nextHint, isRevealFrozen(state) ? freezeHint(state) : '下一轮马上开始…');

    renderAgree(state, result);

    if (app.revealRound !== round) {
      app.revealRound = round;
      animateReveal();
      if (!result.isWin) soundReveal();
    }

    if (won && app.winRound !== round) {
      app.winRound = round;
      celebrate();
      if (result.isWin) soundWin();
    }
  }

  function freezeHint(state) {
    const view = agreeView(state);
    if (view.you && !view.opponent) return '你已确认，等对方也确认；点下面按钮可先进下一轮';
    if (view.opponent && !view.you) return '对方已确认同意词；点下面按钮可先进下一轮';
    return '同意词投票已暂停自动推进，点下面按钮进入下一轮';
  }

  /* ---------------- v2：揭晓面板里的同意词投票区 ---------------- */
  function hideAgreeRow() {
    if (dom.agreeRow) {
      dom.agreeRow.classList.remove('is-on');
      dom.agreeRow.setAttribute('aria-hidden', 'true');
    }
    if (dom.agree) {
      dom.agree.setAttribute('aria-pressed', 'false');
      dom.agree.classList.remove('agree__btn--on');
      dom.agree.disabled = false;
    }
    setText(dom.agreeHint, '');
    setText(dom.agreeOpponent, '');
    if (dom.agreeOpponent) dom.agreeOpponent.classList.remove('is-on');
  }

  /*
   * 只在 phase==='reveal' 且本轮没通关时出现；一模一样通关（isWin）时不出现。
   *  state.agree（缺字段时用 agreeAck 兜底），本地只有 busy 态。
   */
  function renderAgree(state, result) {
    if (!dom.agreeRow) return;
    const show = state.phase === 'reveal' && !(result && result.isWin);
    if (!show) {
      hideAgreeRow();
      return;
    }

    dom.agreeRow.classList.add('is-on');
    dom.agreeRow.setAttribute('aria-hidden', 'false');

    const view = agreeView(state);
    if (dom.agree) {
      dom.agree.textContent = view.you ? '已确认，等对方' : '我认为意思相同';
      dom.agree.setAttribute('aria-pressed', view.you ? 'true' : 'false');
      dom.agree.classList.toggle('agree__btn--on', view.you);
      dom.agree.disabled = !!app.agreeBusy;
      paintBusy(dom.agree, !!app.agreeBusy); // §12
    }
    setText(dom.agreeOpponent, view.opponent ? '对方已确认 ✓' : '对方还没确认');
    if (dom.agreeOpponent) dom.agreeOpponent.classList.toggle('is-on', view.opponent);

    let hint;
    if (view.you && view.opponent) hint = '双方都确认了，正在通关…';
    else if (view.you) hint = '你已确认，等对方也点一下，两个都确认就通关。';
    else if (view.opponent) hint = '对方已确认这两个词是同意词，你这边点一下就通关。';
    else hint = '觉得这两个词说的是一回事？你确认后，等对方也确认就通关。';
    setText(dom.agreeHint, hint);
  }

  function fillRevealCard(card, seat, result, state) {
    if (!card) return;
    const player = findPlayer(state, seat);
    const name = player ? player.name || (seat === 'a' ? '玩家 A' : '玩家 B') : seat === 'a' ? '玩家 A' : '玩家 B';
    const words = result.words || {};
    const timedOut = result.timedOut || {};
    setText(card.querySelector('.reveal__who'), name + (player && player.isYou ? ' · 你' : ''));
    setText(card.querySelector('.reveal__word'), words[seat] || '词穷');
    setText(card.querySelector('.reveal__note'), timedOut[seat] ? '超时，自动填词' : '');
    card.classList.toggle('reveal__card--you', !!(player && player.isYou));
  }

  function animateReveal() {
    [dom.revealA, dom.revealB].forEach((card, index) => {
      if (!card) return;
      card.classList.remove('reveal__card--flip');
      void card.offsetWidth;
      card.style.animationDelay = index * 0.12 + 's';
      card.classList.add('reveal__card--flip');
    });
    dom.verdict.classList.remove('verdict--pop');
    void dom.verdict.offsetWidth;
    dom.verdict.classList.add('verdict--pop');
  }

  function renderHistory(history) {
    if (!dom.history) return;
    const items = Array.isArray(history) ? history : [];
    dom.history.replaceChildren();
    if (!items.length) {
      dom.history.appendChild(el('li', 'history__empty', '还没有记录，第一轮先随便想一个词～'));
      return;
    }
    const seen = {};
    const unique = [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (!item || typeof item.round !== 'number' || seen[item.round]) continue;
      seen[item.round] = true;
      unique.push(item);
    }
    unique.forEach((item) => {
      const li = el('li', 'history__item' + (item.isWin ? ' history__item--win' : ''));
      li.appendChild(el('span', 'history__round', '第 ' + item.round + ' 轮'));
      const words = item.words || {};
      li.appendChild(el('span', 'history__words', (words.a || '词穷') + ' / ' + (words.b || '词穷')));
      li.appendChild(el('span', 'history__flag', item.isWin ? '通关' : '继续'));
      dom.history.appendChild(li);
    });
  }

  /* ---------------- v2：结算视图 ---------------- */
  function playerName(state, seat) {
    const p = findPlayer(state, seat);
    if (p && p.name) return p.name;
    if (p && p.isYou && state && state.you && state.you.name) return state.you.name;
    return seat === 'a' ? '玩家 A' : '玩家 B';
  }

  function rowWinBy(item) {
    if (!item) return null;
    if (item.winBy === 'agree' || item.winBy === 'same') return item.winBy;
    if (item.agree && item.agree.a === true && item.agree.b === true) return 'agree';
    if (item.isWin) return 'same';
    return null;
  }

  function flagText(winBy) {
    if (winBy === 'agree') return '同意词通关';
    if (winBy === 'same') return '一模一样通关';
    return '继续联想';
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + String(n);
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    if (!isFinite(d.getTime())) return '';
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  /*
   * 结算/导出共用的数据模型：只从 state.code / players / history / result / you 取，
   * 不新增后端字段。所有 v2 字段都可能是 undefined，统一在这里兜底成可显示的字符串。
   */
  function settleModel(state) {
    if (!state) return null;
    const rows = dedupeHistory(state.history);
    const result = state.result || null;
    const resultRound = result && typeof result.round === 'number' ? result.round : null;
    if (resultRound !== null && !rows.some((item) => item.round === resultRound)) {
      rows.push({
        round: resultRound,
        basis: state.basis || null,
        words: (result && result.words) || {},
        isWin: !!(result && result.isWin),
        agree: (result && result.agree) || null,
        winBy: (result && result.winBy) || null
      });
    }
    rows.sort((x, y) => x.round - y.round);

    const winBy = resolveWinBy(state, result);
    const last = rows.length ? rows[rows.length - 1] : null;
    const words = (result && result.words) || (last && last.words) || null;
    const code = String(state.code || '----');

    const list = rows.map((item) => {
      const w = item.words || {};
      const basis = item.basis || null;
      return {
        round: item.round,
        a: w.a || '—',
        b: w.b || '—',
        basisA: basis && basis.a ? basis.a : '',
        basisB: basis && basis.b ? basis.b : '',
        winBy: rowWinBy(item),
        flag: flagText(rowWinBy(item))
      };
    });

    let agreeRounds = 0;
    let sameRounds = 0;
    list.forEach((row) => {
      if (row.winBy === 'agree') agreeRounds += 1;
      else if (row.winBy === 'same') sameRounds += 1;
    });

    return {
      code: code,
      winBy: winBy,
      title: winTitle(winBy),
      flag: winBy ? '通关' : '本局结束',
      finalA: words && words.a ? words.a : '—',
      finalB: words && words.b ? words.b : '—',
      nameA: playerName(state, 'a'),
      nameB: playerName(state, 'b'),
      at: app.settleAt || Date.now(),
      dateText: formatDateTime(app.settleAt || Date.now()),
      rows: list,
      totalRounds: list.length,
      agreeRounds: agreeRounds,
      sameRounds: sameRounds,
      fileName: '同声传意-' + code.replace(/[^A-Za-z0-9]/g, '') + '.png'
    };
  }

  function renderSettle(state) {
    // 先固定时间戳再建模型：留守方会反复收到内容相同的 won state，
    // 必须保证 settleAt（以及据此渲染的日期时间）在整个结算期内只取值一次
    if (!app.settleAt) app.settleAt = Date.now();
    const model = settleModel(state);
    if (!model) return;

    setText(dom.settleFlag, model.flag);
    setText(dom.settleTitle, model.title);

    if (dom.settleFinal) {
      dom.settleFinal.replaceChildren(
        el('span', 'settle__word', model.finalA),
        el('span', 'settle__x', '×'),
        el('span', 'settle__word settle__word--b', model.finalB)
      );
    }
    setText(dom.settleMeta, '房间码 ' + model.code + ' · ' + model.nameA + ' 与 ' + model.nameB + ' · ' + model.dateText);

    if (dom.settleRounds) {
      const frag = document.createDocumentFragment();
      if (!model.rows.length) {
        frag.appendChild(el('li', 'settle-round settle-round--empty', '这一局还没有留下轮次记录'));
      } else {
        model.rows.forEach((row) => {
          const li = el('li', 'settle-round' + (row.winBy ? ' settle-round--win' : ''));
          li.appendChild(el('span', 'settle-round__n', '第 ' + row.round + ' 轮'));
          li.appendChild(el('span', 'settle-round__words', row.a + ' / ' + row.b));
          const note = el('span', 'settle-round__note');
          const basis = row.basisA && row.basisB ? '依据 ' + row.basisA + ' × ' + row.basisB : '第一轮：随便想';
          note.appendChild(el('span', 'settle-round__basis', basis));
          note.appendChild(el('span', 'settle-round__flag', row.flag));
          li.appendChild(note);
          frag.appendChild(li);
        });
      }
      dom.settleRounds.replaceChildren(frag);
    }

    setText(
      dom.settleStats,
      '本局共 ' + model.totalRounds + ' 轮 · 同意词确认通关 ' + model.agreeRounds + ' 轮 · 一模一样通关 ' + model.sameRounds + ' 轮'
    );

    // §12：导出按钮的 loading 也按真实忙态在渲染函数里赋值
    paintBusy(dom.export, !!app.exportBusy);
    if (dom.export) dom.export.disabled = !!app.exportBusy;
    applyExportCopyState();
  }

  function clearSettleView() {
    setText(dom.settleFlag, '');
    setText(dom.settleTitle, '—');
    setText(dom.settleFinal, '');
    setText(dom.settleMeta, '');
    setText(dom.settleStats, '');
    if (dom.settleRounds) dom.settleRounds.replaceChildren();
    if (dom.exportPreview) {
      dom.exportPreview.replaceChildren();
      dom.exportPreview.classList.add('is-hidden');
    }
  }

  /* ---------------- v2：图片导出（原生 Canvas 2D，PROTOCOL §11） ---------------- */
  function exportCapability() {
    let share = false;
    let clip = false;
    try {
      share = !!(navigator.share && typeof navigator.share === 'function');
      clip = !!(
        window.ClipboardItem &&
        navigator.clipboard &&
        typeof navigator.clipboard.write === 'function'
      );
    } catch (err) {
      share = false;
      clip = false;
    }
    return { share: share, clip: clip, copy: share || clip };
  }

  function applyExportCopyState() {
    const btn = dom.exportCopy;
    if (!btn) return;
    const can = exportCapability().copy;
    btn.classList.toggle('is-hidden', !can);
    btn.disabled = !can || !!app.exportBusy;
    paintBusy(btn, !!app.exportBusy);
  }

  function triggerDownload(href, fileName) {
    if (!href) return false;
    let anchor = null;
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
        } catch (err) {
          /* ignore */
        }
      }, 1500);
      return true;
    } catch (err) {
      return false;
    }
  }

  function showPreview(url) {
    const box = dom.exportPreview;
    if (!box || !url) return;
    try {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '本局词语列表导出图';
      box.replaceChildren(img);
      box.classList.remove('is-hidden');
    } catch (err) {
      /* 预览失败不影响导出本身 */
    }
  }

  function finishExport(done, message) {
    app.exportBusy = false;
    paintBusy(dom.export, false);
    if (dom.export) dom.export.disabled = false;
    applyExportCopyState();
    toast(message, done ? 'system' : 'info');
  }

  function roundRect(ctx, x, y, w, h, r) {
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

  function fitText(ctx, text, maxWidth) {
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

  /*
   * 整局「海报」出图（PROTOCOL §11）：竖版时间线卡片——逻辑宽固定 1080（保证 dpr=1 也 ≥1080），
   * 按 devicePixelRatio 放大；每一轮是一张卡片，沿左侧时间轴从上往下排，底部是高亮的最终通关卡。
   * 高度随轮次自适应（多轮自然成长图），美术风格沿用应用内暗色霓虹配色与系统字体栈，
   * 不联网、零第三方库。
   */
  function drawPoster(model) {
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
    rows.forEach((row, index) => {
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

      // 联想依据
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
    ctx.fillText(statTxt, cardX + Math.max(30, (cardW - ctx.measureText(statTxt).width) / 2), finalY + finalH - 42);

    // ---- 页脚 ----
    ctx.font = '500 22px ' + POSTER_FONT;
    ctx.fillStyle = '#6c7f9e';
    ctx.fillText(fitText(ctx, '同声传意 · 双人联机 · 想到一起就通关', W - pad * 2), pad, H - pad - footerH + 20);

    return canvas;
  }

  function onExport() {
    if (app.exportBusy) return;
    const model = settleModel(app.state);
    if (!model) {
      toast('这局的数据还没齐，稍等一下再导出');
      return;
    }
    app.exportBusy = true;
    setBusy(dom.export, true);
    if (dom.exportCopy) dom.exportCopy.disabled = true;
    runExport(model);
  }

  function runExport(model) {
    let canvas = null;
    try {
      canvas = drawPoster(model);
    } catch (err) {
      canvas = null;
    }
    if (!canvas) {
      finishExport(false, '这台设备画不出图片，游戏不受影响，可以手动截图保存');
      return;
    }

    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      finishExport(false, message);
    };
    const succeed = (message) => {
      if (settled) return;
      settled = true;
      finishExport(true, message);
    };

    // 回落路径：toDataURL
    const viaDataUrl = () => {
      let url = '';
      try {
        url = canvas.toDataURL('image/png');
      } catch (err) {
        url = '';
      }
      if (!url || url.indexOf('data:image/png') !== 0) return false;
      const clicked = triggerDownload(url, model.fileName);
      showPreview(url);
      if (clicked) succeed('图片已导出（PNG）');
      else fail('浏览器拦住了下载，可以长按/右键预览图保存');
      return true;
    };

    try {
      if (typeof canvas.toBlob !== 'function') {
        if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
        return;
      }
      canvas.toBlob(
        (blob) => {
          if (settled) return;
          let url = '';
          try {
            if (blob && window.URL && typeof URL.createObjectURL === 'function') {
              url = URL.createObjectURL(blob);
            }
          } catch (err) {
            url = '';
          }
          if (!url) {
            if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
            return;
          }
          app.exportBlobUrl = url;
          const clicked = triggerDownload(url, model.fileName);
          showPreview(url);
          // 留足时间给浏览器/系统读取，之后回收，避免内存泄漏
          window.setTimeout(() => {
            try {
              URL.revokeObjectURL(url);
            } catch (err) {
              /* ignore */
            }
          }, 60000);
          if (clicked) succeed('图片已导出，去下载文件夹看看');
          else fail('浏览器拦住了下载，可以长按/右键预览图保存');
        },
        'image/png'
      );
      // toBlob 个别环境不回调，超时后走 dataURL 回落
      window.setTimeout(() => {
        if (settled) return;
        if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
      }, 4000);
    } catch (err) {
      if (!viaDataUrl()) fail('导出失败了，游戏不受影响，可以再点一次');
    }
  }

  /* 可选增强：复制到剪贴板 / 系统分享（不支持时按钮已隐藏） */
  function onExportCopy() {
    if (app.exportBusy) return;
    const model = settleModel(app.state);
    if (!model) {
      toast('这局的数据还没齐，稍等一下再试');
      return;
    }
    const cap = exportCapability();
    if (!cap.copy) {
      toast('这台设备不支持复制或分享，用「导出图片」下载就行');
      return;
    }
    app.exportBusy = true;
    setBusy(dom.exportCopy, true);
    if (dom.export) dom.export.disabled = true;

    let canvas = null;
    try {
      canvas = drawPoster(model);
    } catch (err) {
      canvas = null;
    }
    const done = (ok, message) => {
      app.exportBusy = false;
      paintBusy(dom.exportCopy, false);
      if (dom.exportCopy) dom.exportCopy.disabled = !cap.copy;
      if (dom.export) dom.export.disabled = false;
      toast(message, ok ? 'system' : 'info');
    };
    if (!canvas || typeof canvas.toBlob !== 'function') {
      done(false, '这台设备生成不了图片，用「导出图片」下载吧');
      return;
    }

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          done(false, '生成图片失败了，用「导出图片」再试一次');
          return;
        }
        let shared = false;
        if (cap.share) {
          try {
            const file = new File([blob], model.fileName, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              shared = true;
              const p = navigator.share({ files: [file], title: '同声传意', text: model.code + ' · ' + model.title });
              if (p && typeof p.then === 'function') {
                p.then(
                  () => done(true, '已经打开系统分享'),
                  () => done(true, '已取消分享，图片仍然可以下载')
                );
              } else {
                done(true, '已经打开系统分享');
              }
            }
          } catch (err) {
            shared = false;
          }
        }
        if (shared) return;
        if (cap.clip) {
          try {
            const item = new window.ClipboardItem({ 'image/png': blob });
            const p = navigator.clipboard.write([item]);
            if (p && typeof p.then === 'function') {
              p.then(
                () => done(true, '图片已复制到剪贴板'),
                () => done(false, '复制被浏览器拒绝了，用「导出图片」下载就行')
              );
            } else {
              done(true, '图片已复制到剪贴板');
            }
          } catch (err) {
            done(false, '复制失败了，用「导出图片」下载就行');
          }
          return;
        }
        done(false, '这台设备不支持复制图片，用「导出图片」下载吧');
      },
      'image/png'
    );
  }

  /* ---------------- 倒计时 ---------------- */
  function startCountdown(round, endsAt, phrase) {
    if (app.countdown && app.countdown.round === round) return;
    app.countdown = { round: round, endsAt: endsAt, shown: -1 };
    setText(dom.overlaySub, '第 ' + round + ' 轮 · ' + (phrase || '准备联想…'));
    dom.overlay.classList.add('is-on');
    dom.overlay.setAttribute('aria-hidden', 'false');
    tickCountdown(true);
  }

  function ensureCountdown(state) {
    const round = Number(state.round) || 1;
    if (app.countdownDoneRound === round) return;
    if (app.countdown && app.countdown.round === round) return;
    const now = Date.now();
    let endsAt = Number(state.deadline);
    if (!endsAt || !isFinite(endsAt)) endsAt = now + COUNTDOWN_FALLBACK_MS;
    const remain = endsAt - now;
    if (remain > 6000) endsAt = now + COUNTDOWN_FALLBACK_MS;
    else if (remain < 0) endsAt = now + 400;
    startCountdown(round, endsAt, basisPhrase(state.basis));
  }

  function tickCountdown(force) {
    const cd = app.countdown;
    if (!cd) return;
    const remain = cd.endsAt - Date.now();
    const shown = Math.max(0, Math.min(9, Math.ceil(remain / 1000)));
    if (force || shown !== cd.shown) {
      cd.shown = shown;
      setText(dom.overlayNum, String(shown > 0 ? shown : 1));
      dom.overlayNum.classList.remove('countdown__num--pulse');
      void dom.overlayNum.offsetWidth;
      dom.overlayNum.classList.add('countdown__num--pulse');
      if (shown > 0) soundTick(shown);
    }
    if (remain <= 0) endCountdown(cd.round);
  }

  function endCountdown(round) {
    const had = !!app.countdown;
    app.countdown = null;
    if (round) app.countdownDoneRound = round;
    dom.overlay.classList.remove('is-on');
    dom.overlay.setAttribute('aria-hidden', 'true');
    if (had) soundGo();
  }

  function resetCountdown() {
    app.countdown = null;
    if (!dom.overlay) return;
    dom.overlay.classList.remove('is-on');
    dom.overlay.setAttribute('aria-hidden', 'true');
    setText(dom.overlayNum, '3');
  }

  /* ---------------- 读秒 / 进度条 ---------------- */
  function tickTimers() {
    const state = app.state;
    if (!state) return;
    const fallbackOpen = state.phase === 'countdown' && app.openRound === Number(state.round);
    if (state.phase === 'submitting' || fallbackOpen) {
      const deadline = state.phase === 'submitting' ? Number(state.deadline) : Number(app.openDeadline);
      let remain = SUBMIT_MS;
      if (deadline) {
        remain = deadline - Date.now();
        if (remain > SUBMIT_MS) remain = SUBMIT_MS;
        if (remain < 0) remain = 0;
      }
      dom.timerBar.style.width = ((remain / SUBMIT_MS) * 100).toFixed(1) + '%';
      dom.timerBar.classList.toggle('timer__fill--low', remain <= 10000);
      setText(dom.timerText, remain <= 0 ? '时间到，等揭晓…' : Math.ceil(remain / 1000) + ' 秒');
    } else if (state.phase === 'reveal') {
      if (isRevealFrozen(state)) {
        // 投票后本轮不再自动推进：读秒必须停掉，文案改成手动继续
        setText(dom.nextHint, freezeHint(state));
        return;
      }
      const deadline = Number(state.deadline);
      if (deadline) {
        const left = Math.max(0, deadline - Date.now());
        setText(dom.nextHint, left > 0 ? '下一轮 ' + Math.ceil(left / 1000) + ' 秒后自动开始' : '下一轮马上开始…');
      }
    }
  }

  function loop() {
    tickCountdown(false);
    tickTimers();
  }

  /* ---------------- 撒花 ---------------- */
  function celebrate() {
    try {
      if (!dom.confetti) return;
      dom.confetti.replaceChildren();
      const colors = ['#3ee6d6', '#d8ff5c', '#ff7ab6', '#7aa2ff', '#ffd166'];
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 36; i += 1) {
        const piece = document.createElement('span');
        piece.className = 'confetti-piece';
        piece.style.left = (Math.random() * 100).toFixed(2) + '%';
        piece.style.background = colors[i % colors.length];
        piece.style.width = (6 + Math.random() * 6).toFixed(1) + 'px';
        piece.style.height = (10 + Math.random() * 8).toFixed(1) + 'px';
        piece.style.animationDuration = (1.8 + Math.random() * 1.6).toFixed(2) + 's';
        piece.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
        piece.style.setProperty('--dx', (Math.random() * 160 - 80).toFixed(0) + 'px');
        piece.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
        frag.appendChild(piece);
      }
      dom.confetti.appendChild(frag);
      window.setTimeout(() => {
        if (dom.confetti) dom.confetti.replaceChildren();
      }, 4400);
    } catch (err) {
      /* 撒花失败无所谓 */
    }
  }

  /* ---------------- Socket 事件 ---------------- */
  function onState(state) {
    render(state);
  }

  function onCountdownEvent(payload) {
    if (!payload) return;
    const round = Number(payload.round) || (app.state ? Number(app.state.round) : 1) || 1;
    const seconds = Number(payload.seconds) > 0 ? Number(payload.seconds) : 3;
    startCountdown(round, Date.now() + seconds * 1000, basisPhrase(payload.basis));
  }

  function onRoundOpen(payload) {
    if (app.countdown) endCountdown(app.countdown.round);
    if (!app.state) return;
    const round = Number(payload && payload.round) || Number(app.state.round) || 1;
    if (Number(app.state.round) !== round) return;
    // 服务端已开闸：先解锁输入，内容与判定仍以随后的 room:state 为准
    if (app.state.phase === 'countdown') {
      app.openRound = round;
      app.openDeadline = Number(payload && payload.deadline) || Date.now() + SUBMIT_MS;
      render(app.state);
    }
    if (!isSubmittedYou(app.state)) {
      try {
        dom.word.focus();
      } catch (err) {
        /* ignore */
      }
    }
  }

  function onOpponentSubmitted() {
    app.opponentSubmitted = true;
    if (app.state && app.state.phase === 'submitting') render(app.state);
  }

  function onRevealEvent(payload) {
    if (!payload || !payload.round) return;
    app.lastReveal = payload;
    app.opponentSubmitted = false;
    if (!app.state || Number(app.state.round) !== Number(payload.round)) return;
    if (app.state.phase === 'submitting' || app.state.phase === 'countdown') {
      if (app.state.phase === 'countdown') endCountdown(Number(payload.round));
      showView('game');
    }
    render(app.state);
  }

  function onNotice(payload) {
    if (!payload || !payload.text) return;
    toast(payload.text, payload.kind || 'info');
  }

  function onAborted() {
    toast('这局结束啦，回首页重新开一局吧');
    teardown('');
  }

  function onRoomError(payload) {
    const code = payload && payload.code;
    const message = (payload && payload.message) || '房间出了点问题';
    if (app.ignoreState) return;
    if (code === 'OPPONENT_LEFT') {
      teardown('对方离开了，这局结束');
      return;
    }
    if (code === 'REPLACED') {
      teardown('这个房间在别处打开了，这里先退出');
      return;
    }
    if (code === 'ROOM_DELETED') {
      teardown('房间已经关闭了');
      return;
    }
    toast(message);
  }

  function initSocket() {
    if (typeof window.io !== 'function') {
      setNet('联机脚本没加载出来，刷新页面试试');
      return;
    }
    const socket = window.io({
      reconnection: true,
      reconnectionDelay: 700,
      reconnectionDelayMax: 4000
    });
    app.socket = socket;

    socket.on('connect', () => {
      setNet(null);
      // 断线重连：之前在途请求的 ack 永远不会回来了，所有 loading 必须先归位
      resetAllLoading();
      if (app.state && !app.ignoreState) render(app.state);
      if (app.session && !app.pendingJoin) tryRestore();
    });

    socket.on('disconnect', () => {
      if (app.session || app.state) setNet('连接断开了，正在自动重连…');
    });

    socket.on('connect_error', () => {
      setNet('连不上服务器，正在重试…');
    });

    socket.on('room:state', onState);
    socket.on('round:countdown', onCountdownEvent);
    socket.on('round:open', onRoundOpen);
    socket.on('round:opponent-submitted', onOpponentSubmitted);
    socket.on('round:reveal', onRevealEvent);
    socket.on('room:notice', onNotice);
    socket.on('room:error', onRoomError);
  }

  /* ---------------- 事件绑定 ---------------- */
  function onCodeInput() {
    const normalized = normalizeCode(dom.code.value);
    if (dom.code.value !== normalized) dom.code.value = normalized;
  }

  function bindEvents() {
    dom.create.addEventListener('click', onCreate);
    dom.join.addEventListener('click', onJoin);
    dom.code.addEventListener('input', onCodeInput);
    dom.code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onJoin();
      }
    });
    dom.nickname.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCreate();
      }
    });
    dom.copy.addEventListener('click', onCopy);
    dom.ready.addEventListener('click', onReady);
    dom.leaveRoom.addEventListener('click', () => leaveNow('已离开房间'));
    dom.word.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submitWord();
      }
    });
    dom.submit.addEventListener('click', submitWord);
    dom.next.addEventListener('click', onNext);
    if (dom.agree) dom.agree.addEventListener('click', onAgree);
    if (dom.export) dom.export.addEventListener('click', onExport);
    if (dom.exportCopy) dom.exportCopy.addEventListener('click', onExportCopy);
    dom.restart.addEventListener('click', onRestart);
    dom.exit.addEventListener('click', () => leaveNow('已离开房间'));
    dom.leaveWin.addEventListener('click', () => leaveNow('已离开房间'));
    dom.sound.addEventListener('click', onSoundToggle);
    document.addEventListener(
      'pointerdown',
      () => {
        getCtx();
      },
      { once: true }
    );
  }

  /* ---------------- 邀请链接 ---------------- */
  function handleInviteLink() {
    let params = null;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (err) {
      params = null;
    }
    if (!params) return;
    const raw = params.get('room');
    if (!raw) return;
    const code = normalizeCode(raw);
    dom.code.value = code;
    // 打开的是别人的邀请链接时，优先展示首页加入，不当成上一次的断线重连
    if (app.session && app.session.code && app.session.code !== code) clearSession();
    window.setTimeout(() => {
      try {
        dom.join.focus();
      } catch (err) {
        /* ignore */
      }
    }, 80);
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    // token 存 sessionStorage：同一浏览器多标签页各自是独立玩家，刷新仍可断线重连
    let token = readLive(KEY_TOKEN);
    if (!token) {
      token = makeToken();
      writeLive(KEY_TOKEN, token);
    }
    app.token = token;

    app.session = readSession();
    if (app.session && !app.session.token) app.session.token = app.token;

    const savedNick = readStore(KEY_NICK);
    if (savedNick) dom.nickname.value = truncate12(savedNick);

    app.soundOn = readStore(KEY_SOUND) !== '0';
    applySoundLabel();

    bindEvents();
    handleInviteLink();
    renderHistory([]);
    hideAgreeRow();
    clearSettleView();
    applyExportCopyState();
    showView('home');
    initSocket();
    window.setInterval(loop, TICK_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
