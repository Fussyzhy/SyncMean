# 同声传意 · 联机版 —— 协议契约 v2（前后端唯一事实来源）

> 本文件由 Lead 维护，后端与前端都必须严格按此实现。任何字段名、事件名不得擅自改动；确有需要先在此文件里改。
>
> **v2 变更（相对 v1）**：
> 1. 项目名从「321 联想词」改为「**同声传意**」（仅文案/标题/日志前缀；事件名、字段名、DOM id、端口一律不变）。
> 2. 新增 `round:agree`：揭晓后双方可各自确认「这两个词算同意词」，**两票都投出即通关**（`winBy: 'agree'`）。
> 3. 新增结算视图与图片导出（纯前端 Canvas，见 §9/§11）。
> 4. 明确按钮 loading 态的清理责任（见 §12）。

## 0. 产品范围

- 双人联机：A、B 各自想一个词，双方**都提交后**才同时揭晓（服务器绝不提前泄露）。
- 两个词**归一化后相同** → 通关（`winBy: 'same'`）。
- 两个词不同 → 以【本轮两个词】为联想依据进入下一轮。
- **v2**：揭晓后若双方都确认「这两个词算同意词」→ 同样通关（`winBy: 'agree'`）。判定权在玩家，服务器不做任何语义判断。
- 整局通关后进入**结算视图**，展示最终成功的词与逐轮词语，支持导出一张整局词语列表图片。
- 房间 4 位码，昵称进入，无需注册/登录。只有「普通模式」。本地运行，单端口。
- 手机竖屏优先，桌面同样好看。

## 1. 技术栈与目录

- Node.js ≥ 18，Express 4 + Socket.IO 4，CommonJS（`require`）。
- 前端纯 HTML/CSS/JS，**不引入任何 CDN 资源**（离线可跑）。Socket.IO 客户端用服务端自动提供的 `/socket.io/socket.io.js`。
- 图片导出用浏览器原生 Canvas 2D，**不得引入任何第三方绘图库**。

```
server.js          Express + Socket.IO 装配、HTTP 路由
src/game.js        房间与对局状态机（不依赖 socket，通过回调/事件驱动）
tools/sim.js       端到端测试：用 socket.io-client 起两个假玩家跑完整流程
public/index.html  单页四视图（首页 / 房间 / 对局 / 结算）
public/style.css
public/app.js
.verify/ui-e2e.js  真浏览器验收（Lead 维护）
```

**写入边界**：
- 后端只改 `server.js`、`src/game.js`、`tools/sim.js`。
- 前端只改 `public/**`。
- `package.json`、`PROTOCOL.md`、`README.md`、`.verify/**` 由 Lead 维护，前后端均不得改。

## 2. 运行

- `npm start`，端口 `process.env.PORT || 3210`。
- `GET /health` → `{ "ok": true, "rooms": <房间数> }`
- 静态目录 `public/`，`GET /` 返回 `public/index.html`。
- 未匹配的路由回落到 `index.html`（保证 `/?room=ABCD` 可用）。
- 服务端日志前缀统一为 `[同声传意]`。

## 3. 时间参数（集中在 `src/game.js` 顶部常量）

```js
const COUNTDOWN_MS = 3000;  // 3-2-1
const SUBMIT_MS    = 60000; // 提交时限
const REVEAL_MS    = 4500;  // 揭晓停留，之后自动进入下一轮
const START_DELAY  = 300;   // 双方准备后稍等再倒计时
```

**v2 规则**：本轮一旦有人投出「同意词」票，该轮的 4.5s 自动推进计时器**立即取消且不再恢复**（`deadline = null`），此后只能由玩家手动点 `round:next` 进入下一轮。撤票也不恢复计时——这条规则必须简单、可预测。

## 4. 服务端数据模型（内部，不下发）

```js
Room {
  code: string,            // 4 位，字符集 A-Z2-9，排除 0/O/1/I
  phase: 'lobby'|'countdown'|'submitting'|'reveal'|'won'|'aborted',
  round: number,           // 当前/即将进行的轮次，从 1 开始
  basis: {a,b}|null,       // 本轮联想依据；第 1 轮为 null
  players: [Player],       // 最多 2 个，按加入顺序 seats = ['a','b']
  submissions: {a:Sub|null, b:Sub|null},  // Sub = {word, timedOut}
  agree: {a:boolean, b:boolean},   // v2：本轮同意词投票，进入新一轮/倒计时时全部清零
  revealFrozen: boolean,           // v2：本轮是否已因投票取消自动推进
  lastGame: Snapshot|null,         // v2.1：整局结束后的冻结快照，供未退出结算页的玩家继续 won 视角
  result: Result|null,
  history: [HistoryItem],
  timer: Timeout|null,     // 当前阶段唯一计时器
  createdAt: number
}
Snapshot { round, basis:{a,b}|null, history:[HistoryItem], result:Result, endedAt:number }
Player { token, name, seat, socketId, ready, connected, isHost, settleDismissed:boolean }
Result  { round, words:{a,b}, isWin, timedOut:{a,b}, agree:{a,b}, winBy:'same'|'agree'|null }
HistoryItem { round, basis:{a,b}|null, words:{a,b}, isWin, agree:{a,b}, winBy:'same'|'agree'|null }
```

## 5. 事件协议

所有「客户端 → 服务端」的请求都通过 ack 回调返回结果：

```js
socket.emit('room:create', { name, token? }, (res) => { ... })
// 成功: { ok: true, ...字段 }
// 失败: { ok: false, error: 'ERROR_CODE', message: '中文提示' }
```

### 5.1 客户端 → 服务端

| 事件 | 请求体 | ack 成功返回 | 说明 |
|---|---|---|---|
| `room:create` | `{name, token?}` | `{ok, code, token, seat:'a'}` | 建房，创建者即 seat a / host |
| `room:join` | `{code, name, token?}` | `{ok, code, token, seat, state}` | 加入或**断线重连**：若 token 命中房间内已有玩家 → 恢复该玩家（任意 phase 都允许） |
| `room:leave` | `{}` | `{ok:true}` | 主动离开 |
| `player:ready` | `{ready:boolean}` | `{ok:true}` | 仅 lobby 阶段有效 |
| `round:submit` | `{word:string}` | `{ok:true, submitted:true}` | 仅 submitting 阶段；**不得**在返回或广播里泄露对方已提交的内容 |
| `round:agree` | `{agree:boolean}` | `{ok:true, agree:{a,b}, winBy:'agree'\|null}` | **v2**。仅 reveal 阶段有效。为本人投/撤「这两个词算同意词」。`agree` 缺省视为 `true`。两票齐 → 立即通关（`winBy:'agree'`）。幂等：重复投同一方向不报错 |
| `round:next` | `{}` | `{ok:true}` | reveal 阶段：跳到下一轮（含投票冻结后手动继续） |
| `game:restart` | `{}` | `{ok:true, watching:boolean}` | won 阶段：**本人**退出结算页回到 lobby（round=1, basis=null, history=[], ready 全 false, result=null, agree 全 false, revealFrozen=false）。若对方还留在结算页，服务端把整局冻结成 `lastGame` 快照继续为 TA 呈现 won 视角（见 §5.3.1）。对方也已退出时 `lastGame` 才置 null。 |

`room:join` 规则优先级：
1. `token` 命中房间内已有玩家 → 重连（新 socketId 顶替旧的，旧连接收到 `room:error {code:'REPLACED'}` 并被移出房间频道）。
2. 房间不存在 → `ROOM_NOT_FOUND`。
3. 房间已有 2 人 → `ROOM_FULL`。
4. phase !== 'lobby' → `ROOM_IN_PROGRESS`。
5. 否则以 `seat:'b'` 加入。

`round:agree` 细则：
- 仅 `phase === 'reveal'` 允许，否则 `BAD_PHASE`；不在房间 `NOT_IN_ROOM`。
- 只接受 `true|false`（`Boolean` 归一），无长度/内容入参。
- 首次出现任一 `true` 票时：`_clearTimer` + `revealFrozen = true` + `deadline = null` + 广播 state。
- 两票都为 `true` 时（顺序无所谓，后到的一票触发）：
  - `result.isWin = true`、`result.winBy = 'agree'`、`result.agree = {a:true,b:true}`；
  - **同步更新本轮 history 末项**的 `isWin=true / winBy='agree' / agree={a:true,b:true}`（结算与导出图依赖 history）；
  - `phase = 'won'`、`deadline = null`、计时器清空；
  - 广播 `room:notice {kind:'system', text:'双方都确认是同意词，通关！'}`，随后按接收者视角 `room:state`。
  - **不再重发 `round:reveal`**（前端以 state 为准渲染 won）。
- 撤票（`agree:false`）：仅在自己已是 `true` 时把本座位清零，不恢复自动推进。
- 双方都是 `true` 之后不允许再撤（已 `won`，返回 `BAD_PHASE`）。
- 超时自动填的「词穷」同样可以投同意词票（判定权在玩家）。

### 5.2 服务端 → 客户端（都发到房间频道）

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `room:state` | `PublicRoomState`（见 §5.3，**按接收者视角生成**） | 任何状态变化后、加入后、重连后 |
| `round:countdown` | `{round, basis, seconds:3}` | 进入 countdown 阶段 |
| `round:open` | `{round, basis, deadline}` | 倒计时结束、输入开放；`deadline = 服务端 now + SUBMIT_MS` |
| `round:opponent-submitted` | `{}` | 对方已提交（仅提示，不含文字） |
| `round:reveal` | `{round, basis, words:{a,b}, isWin, timedOut:{a,b}, agree:{a,b}, winBy, history}` | 双方都提交（或超时自动提交）后，**同时**揭晓。此刻 `agree` 必为 `{a:false,b:false}`、`winBy` 为 `'same'` 或 `null` |
| `room:notice` | `{text:string, kind:'join'\|'leave'\|'info'\|'system'}` | 有人进出、同意词通关等提示，前端做 toast |
| `room:error` | `{code, message}` | 会话级错误（`OPPONENT_LEFT`、`REPLACED`、`ROOM_DELETED`） |

### 5.3 PublicRoomState（前端渲染的唯一依据）

```js
{
  code: 'AB12',
  phase: 'lobby'|'countdown'|'submitting'|'reveal'|'won'|'aborted',
  round: 1,
  basis: { a: '苹果', b: '云朵' } | null,
  you:  { seat: 'a'|'b', name: '小明', isHost: true },
  players: [
    { seat:'a', name:'小明', isHost:true,  ready:true,  connected:true, isYou:true, settleDismissed:true },
    { seat:'b', name:'小红', isHost:false, ready:false, connected:true, isYou:false, settleDismissed:false }
  ],
  submitted: { you: false, opponent: false },   // 只给布尔，永不给词
  settlePending: false,                        // v2.1：Boolean(room.lastGame)，即「有一局结算还挂着没人收」
  agree:     { you: false, opponent: false },   // v2，只给布尔；reveal 阶段之外恒为 false
  revealFrozen: false,                          // v2，本轮自动推进是否已被投票取消
  deadline: 1761882000000 | null,               // 服务端毫秒时间戳；null 表示无倒计时
  result: {
    round, words:{a,b}, isWin, timedOut:{a,b},
    agree:{a,b},                                // v2
    winBy: 'same'|'agree'|null                  // v2
  } | null,
  history: [ { round, basis:{a,b}|null, words:{a,b}, isWin, agree:{a,b}, winBy } ]
}
```

`deadline` 语义：countdown = 倒计时结束时刻；submitting = 提交截止；reveal = 下一轮开始时刻；`revealFrozen` 为真时 reveal 的 `deadline` 为 `null`。won / lobby / aborted 恒为 `null`。

`agree` 视角说明：`agree.you` 是本人本轮投票，`agree.opponent` 是对方是否已投票。**绝不**因为对方投了票就泄露任何文字内容（此阶段词本来就已公开，无额外风险）。

**v2 已确认语义（Lead 裁定）**：reveal 期间 `result.agree` 实时镜像当前票面（例如 A 投了就是 `{a:true,b:false}`），但 `result.isWin` / `result.winBy` 在两票齐之前**不变**（仍是 `false` / `null`）；两票齐后才是 `{a:true,b:true}` + `isWin:true` + `winBy:'agree'`。前端渲染投票区应以 `state.agree.{you,opponent}` 为准，`result.agree` 只是同一事实的座位视角副本，可用于结算与导出图。

### 5.3.1 结算页的「各自退出」（v2.1，替代旧裁定）

旧裁定「restart 立即清空、重开后不能回看」**作废**。新语义：

> 一方点「再来一局」只让**自己**回到准备页；另一方**不被强制退出**，可以继续停留在结算页查看、导出，直到 TA 自己也点「再来一局」。

实现口径（服务端负责，前端几乎不改）：

- Room 新增 `lastGame: Snapshot | null`，`Snapshot = { round, basis, history, result, endedAt }`（`history`/`result` 形状与 §5.3 完全一致，前端结算/导出可直接复用）。
- Player 新增 `settleDismissed: boolean`（本玩家是否已退出结算页）。存在玩家对象上，所以**断线重连后仍保持**在结算页。
- `game:restart` 语义变为「我退出结算页」：
  1. 首次有人退出（内部 `phase==='won'`）：先把整局冻结进 `lastGame`，再把房间内部重置为 `lobby`（`round=1`、`basis=null`、`submissions/agree/revealFrozen/result/history` 清空、`deadline=null`、所有 `ready=false`——与旧行为相同），并置**点击者** `settleDismissed=true`、其余人 `false`。
  2. 后续有人退出（内部已是 `lobby`）：只把自己 `settleDismissed=true`；当**房间内所有玩家**都已退出 → `lastGame=null`。
- **视角门控（关键）**：`getState(room, player)` 里，若 `room.lastGame && !player.settleDismissed`，则该玩家看到的 state 为「won 视角」：`phase:'won'`、`round/basis/history/result` 全部取自 `lastGame`、`deadline:null`、`submitted` 与 `agree` 全 false、`revealFrozen:false`。已退出的人看到真实房间状态。因此前端**仍然只按 `state.phase` 决定渲染哪一屏**，不需要新增分支。
- 因为看到 `phase:'won'`，未退出的人自然点不到「准备」；服务端还必须**硬拒**：`player:ready` 对「`lastGame` 存在且本人 `settleDismissed===false`」的玩家返回 `BAD_PHASE`（防止陈旧或被改过的前端绕过）。
- 对局不可能在有人还在看结算时开始：`_scheduleStart` 需要两人都 ready，而未退出者无法 ready；另外 `_startCountdown` 强制 `lastGame=null` 且所有人 `settleDismissed=false`（兜底）。
- `room:notice` 改为**定向**发（不再 `_emitRoom` 广播）：退出者收 `{kind:'info', text:'已回到房间，可以再来一局'}`；仍在看结算的人收 `{kind:'system', text:'对方已经回到房间等你，看完点「再来一局」'}`。
- 结算页数据只来自快照，所以**留在结算页的人依然可以导出图片**（必须可用）。
- 这些情况必须清掉 `lastGame` 并把所有在场玩家 `settleDismissed=false`，避免有人卡在假 won：`leaveRoom`（含对局中离开导致 aborted）、`sweep` 删除房间、新玩家加入同一房间、`aborted` 相位。
- `game:restart` 的合法相位放宽为：`phase==='won'` **或** `room.lastGame && !player.settleDismissed`（后者是「对方先点了，我后点」）。其余情况仍 `BAD_PHASE`。幂等：已退出的人再点返回 `BAD_PHASE`。
- ack 返回 `{ ok: true, watching: boolean }`，`watching` = 是否还有别人留在结算页。
- `players[]` 每项新增 `settleDismissed: boolean`，供准备页提示「对方还在看结算」。
- **v2.1 重要坑（必须遵守）**：`settleDismissed` 的**初值就是 `false`**（新房、新加入者都是 false），所以「`opponent.settleDismissed === false`」单独使用是**错的**——全新房间会把双方的准备按钮永久锁死，游戏根本开不了。准备页锁定的判定必须是**两个条件同时成立**：
  ```js
  const watching = state.phase === 'lobby'
    && state.settlePending === true          // 真的有 lastGame 快照挂着
    && opponent && opponent.settleDismissed === false;
  ```
  因此 §5.3 新增 `settlePending: boolean = Boolean(room.lastGame)`（对所有视角一致下发，包括留守者自己的 won 视角）。前端对 `settlePending` **缺失/非 true 一律按 false 处理**（不锁），保证老后端或未更新的后端不会把按钮锁死。

### 5.4 错误码

`INVALID_NAME`(昵称为空/超 12 字) `INVALID_CODE` `ROOM_NOT_FOUND` `ROOM_FULL` `ROOM_IN_PROGRESS` `NOT_IN_ROOM` `BAD_PHASE` `INVALID_WORD`(空或超 12 字) `REPLACED` `OPPONENT_LEFT` `ROOM_DELETED` `INTERNAL`

`message` 一律中文，可直接展示给玩家。同意词相关的所有拒绝都用 `BAD_PHASE`，不新增错误码。

## 6. 判定规则

```js
function normalize(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
isWin = normalize(a) !== '' && normalize(a) === normalize(b);
```

（全角半角、大小写、标点、空格不影响判定。）

`winBy` 优先级：
- 上述 `isWin` 成立 → `winBy = 'same'`，直接进入 won（reveal 阶段都不会出现，因此没有投票机会）。
- 上述不成立 → 进入 reveal，`isWin = false`、`winBy = null`；此后仅当双方都投 `round:agree` → `isWin = true`、`winBy = 'agree'`。
- 服务器**不判断**语义是否真的同义；`'agree'` 只代表双方玩家一致认可。

## 7. 对局流程状态机

```
lobby --(两人 ready, 延迟 300ms)--> countdown(3s) --> submitting(≤60s)
submitting --(两人都提交 / 60s 超时自动填「词穷」)--> [判定]
   ├─ 归一化相同 --> won（winBy='same'，发 round:reveal, phase=won, 无计时器）
   └─ 不同     --> reveal(4.5s)
reveal --(任一玩家 round:agree=true)--> reveal（冻结：清计时器, deadline=null, revealFrozen=true）
reveal --(双方都 round:agree=true)----> won（winBy='agree'，更新 history 末项，room:notice）
reveal --(round:next)--> countdown(下一轮) 立即
reveal --(4.5s 无人投票)--> countdown(下一轮)
won --(game:restart)--> lobby（清空 history/result/ready/agree/revealFrozen；整局冻结进 lastGame 供未退出者继续看）
won --(一方已 restart，另一方仍在结算页)--> 内部已是 lobby，但留守者仍看到 won 视角（§5.3.1）
```

- 进入下一轮时：`round += 1`，`basis = 本轮 words`，清空 submissions，`agree = {a:false,b:false}`，`revealFrozen = false`，`phase='countdown'`。
- `_startCountdown` 与 `_advanceRound` 都必须清零 `agree` 与 `revealFrozen`（同一局多轮之间投票不串轮）。
- 每次相位变化都要 `room:state` 广播；除 `round:countdown` / `round:open` 外不要用其他事件改相位。
- 每个房间同一时刻只有一个 `timer`，切换相位前必须 `clearTimeout`。

## 8. 断线 / 离开

- socket 断开：玩家标记 `connected:false`，广播 state；房间保留。对局继续（对方可等，超时自动提交兜底）。
- 主动 `room:leave` 或双断线清理：若剩余 0 人 → 删除房间；剩余 1 人在进行中 → 该玩家收到 `room:error {code:'OPPONENT_LEFT'}`, `state.phase='aborted'`。
- host 离开 → 剩余玩家 `isHost=true`。
- 空房间 / 全员离线超 10 分钟：清理（周期扫描）。
- reveal 冻结期间对方离开：同样走 `aborted`。

## 9. 必须存在的 DOM id（自动化验收用，前端不得改名）

```
#view-home  #view-room  #view-game
#nickname-input  #btn-create  #code-input  #btn-join
#room-code  #btn-copy  #btn-ready  #btn-leave-room
#basis  #word-input  #btn-submit  #waiting-hint
#reveal-a  #reveal-b  #reveal-verdict  #toast  #history
```

**v2 新增（同意词投票）**，位于对局视图的揭晓面板内：

```
#agree-row            投票区容器（仅 phase=reveal 且未通关时可见）
#btn-agree            本人「我认为意思相同」切换按钮，aria-pressed 表示已投
#agree-hint           说明/等待文案（例：「等对方也确认，就通关」）
#agree-opponent       对方已确认的状态标记（存在即可，内容由前端决定）
```

**v2 新增（结算视图）**，第四个视图 `#view-settle`，**接收者视角** `state.phase === 'won'` 时展示（对方已 restart 时，留守者的 won 视角来自 `lastGame` 快照，见 §5.3.1）：

```
#view-settle          结算视图容器
#settle-title         通关方式标题（一模一样通关 / 双方确认同意词通关）
#settle-final         最终成功的词（本轮两个词都要呈现）
#settle-meta          房间码、双方昵称、日期时间
#settle-rounds        逐轮词语列表（第 N 轮 · A 词 / B 词 · 标记）
#settle-stats         统计信息（总轮次、其中同义确认轮数等）
#btn-export           导出整局词语列表图片
#btn-export-copy      （可选）复制到剪贴板；不支持时可隐藏
#export-preview       （可选）导出后的预览容器
#btn-restart          再来一局（从旧 #win-actions 移入本视图，id 不变）
#btn-leave-win        离开（同上，id 不变）
```

`#btn-restart` / `#btn-leave-win` 的 id 与语义保持不变，只是宿主容器改为结算视图；`#win-actions` 容器名不再被要求。自动化验收会通过这两个 id 驱动重开流程。

## 10. 验收标准

1. `npm test` 通过：`tools/sim.js` 自起服务，两个 socket 客户端完成 创建→加入→双方 ready→收到 countdown→open→各自 submit→reveal 判定「不同」→下一轮→第二轮提交相同→won→restart→回 lobby；断言所有关键事件与字段，并断言「在对方提交前拿不到对方词」。
2. `npm test` 额外覆盖 v2 同意词链路：某轮判定「不同」→ A 投 `round:agree` → 断言 state 出现 `agree.you=true / agree.opponent=false / revealFrozen=true / deadline=null` 且**不再自动推进**（等待 > `REVEAL_MS` 仍停在 reveal）→ B 投 `round:agree` → 断言 `phase='won'`、`result.winBy='agree'`、`result.isWin=true`、`history` 末项 `isWin=true/winBy='agree'`、收到 `room:notice`。
3. `npm test` 还需断言：撤票可把 `agree.you` 变回 `false` 且 `revealFrozen` 保持 `true`；`won` 阶段投 `round:agree` 返回 `BAD_PHASE`；进入新一轮后上一轮投票清零；`agree` 在非 reveal 阶段的 state 中恒为 `{you:false, opponent:false}`。
4. `npm start` 后 `GET /health` 返回 200，响应体形状不变。
5. 页面无 console 报错，`/?room=ABCD` 能预填房间码。
6. 手机 375px 宽无横向滚动、按钮可点。
7. **回归（bug 4）**：完整跑一局至通关 → 点「再来一局」回到房间页 → `#btn-ready` 必须**没有** `is-busy` 类、`aria-busy` 已移除、`textContent` 为「准备」。任意一次 `#btn-ready` 点击之后（无论成功、失败、切页、断线重连）都不得残留 `is-busy`。
8. **结算与导出**：`phase==='won'` 时展示 `#view-settle`，`#settle-rounds` 至少列出所有已玩轮次；点 `#btn-export` 产出一张 PNG（`blob` 或 `dataURL`），文件名含房间码，页面上给出成功/失败提示，且**导出失败不得影响游戏继续**。
9. **结算页各自退出（v2.1）**：A 点 `game:restart` 后——A 立刻是 lobby 视角（能看准备页、能点准备），**B 仍是 won 视角**（`state.phase==='won'`、`history`/`result` 等于通关那一刻的快照、`deadline===null`），B 的 `history` 不得被清空、不得被换成新一轮的空数据；B 此时点 `player:ready` 必须 `BAD_PHASE`；B 留在结算页期间仍可导出图片且内容与被踢无关。B 再点 `game:restart` 后两人才都进 lobby，`lastGame` 置 null。断言 ack 的 `watching` 字段：A 那次为 `true`、B 那次为 `false`。另需覆盖：留守方**断线重连后仍在结算页**；一方在对方留守时 `room:leave` → 留守方脱离假 won（收到 `OPPONENT_LEFT`/`aborted`，`lastGame` 被清）。
10. **新房不得被结算锁定误伤（v2.1 回归）**：全新房间、从未打过一局时 `state.settlePending === false` 且所有 `players[].settleDismissed === false`，此时准备按钮**必须可用**、`player:ready` 必须成功、双方准备后必须进入 countdown。页面上 `#room-tip` 在真正出现留守者前不得显示「还在看结算」类文案。

## 11. 导出图片契约（纯前端）

- 数据来源只能是 `room:state` 里的 `code / players / history / result / round`，**不得**为此新增后端字段。
- 用 `document.createElement('canvas')` + 2D context 绘制，宽度 1080 逻辑像素（配合 `devicePixelRatio` 缩放，最终 PNG 宽度 ≥1080），高度按轮次自适应，轮次多时不得截断。
- 画面必须包含：标题「同声传意」、房间码、双方昵称、逐轮「第 N 轮：A 词 / B 词」（通关轮要标记通关方式）、最终成功的词、日期。
- **版式（竖版时间线）**：整体是竖向长图时间线——左侧一条时间轴 + 每轮一个圆形节点（节点内是轮次序号），右侧每轮一张卡片自上而下排列（卡内两个词分列，通关标记做成右上角胶囊，下方一行「联想依据」），底部是一张高亮的「最终成功的词」卡。**只改结构，配色/字体/发光沿用应用内暗色霓虹风格**（背景 `#0b1526→#060a12`、青 `#3ee6d6`、柠 `#d8ff5c`、粉 `#ff7ab6`）。轮次越多图越长（3 轮起即为高>宽的竖版）。
- 字体只用系统可用字体栈（含中文，例如 `"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`），不得联网取字体或图片。
- 优先 `canvas.toBlob → URL.createObjectURL → <a download>`；`toBlob` 或下载不可用时回落 `toDataURL`；再失败则 toast 明确提示。允许在 `navigator.share` / `ClipboardItem` 可用时追加「复制到剪贴板/系统分享」，但必须是**可选增强**，不可用时隐藏入口。
- 导出为一次性动作，按钮需防重复点击并有 loading/结果提示。

## 12. 按钮 loading 态清理（bug 4 的硬约束）

- 任何通过 `setBusy(btn, true)` 进入 loading 的按钮，**必须在渲染函数里按当前真实忙态重新赋值**（`classList.toggle('is-busy', busy)`），不能只依赖请求回调去移除。
- 理由：ack 回调到达时服务端可能已广播了新 phase，渲染函数走了别的分支，`is-busy` 就永久残留；而 CSS 里 `.btn.is-busy { color: transparent }` 会让按钮「没有文字 + 一直转圈」。
- 因此：`renderRoom` 必须显式清/设 `#btn-ready` 的 `is-busy` 与 `aria-busy`；`renderPlay` 必须对 `#btn-submit` 同理；回到 lobby、离开房间、`aborted`、重开、断线重连这几条路径都要把各自按钮的 loading 态归位。
- 新加的 `#btn-agree` / `#btn-export` 也必须遵守同一条规则。
