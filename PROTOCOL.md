# 同声传意 · 联机版 —— 协议契约 v3.5（前后端唯一事实来源）

> 本文件由 Lead 维护，后端与前端都必须严格按此实现。任何字段名、事件名不得擅自改动；确有需要先在此文件里改。
>
> **v3.5 变更（相对 v3.4）**：新增**管理后台 `/admin`**（独立 Socket.IO namespace `/admin`），玩家协议、玩家事件、`PublicRoomState` 与既有 DOM id **零变化**：
> 1. 管理后台用 `ADMIN_KEY` 鉴权（本地 `.env` / 进程环境变量），独立 namespace `/admin`，握手 `auth:{key}`；管理员 socket 不进入任何房间频道，观战与终止房间都不影响玩家对局协议。
> 2. 实时房间列表（`admin:rooms` 推送 + `admin:rooms:request` 主动拉取）、实时观战（`admin:room:watch` → `admin:room:state`）、终止删除房间（`admin:room:delete` → 玩家收到既有 `room:error {code:'ROOM_DELETED'}`）。
> 3. 类型定义在 `src/shared/admin.ts`（§14 的 TypeScript 映射）。新增 `.env.example`（模板）与 `.env`（gitignore）。新增管理后台 DOM id（见 §9/§14）与 `yarn verify:admin` 浏览器验收。
>
> **v3.4 变更（相对 v3.3）**：新增两个客户端事件，其余下发字段零变化：
> 1. **快捷表情 `room:emote`**：仅 `submitting` 阶段可用，只允许预设白名单 `nudge` / `thinking` / `cheer`（**不接受自由文本**，避免变成双盲暗示通道）。服务端按 8s 冷却限流，把预设文案以 `room:notice {kind:'info'}` 定向发给对方；ack 返回 `{ok:true, accepted:boolean}`（冷却/对方离线时 `accepted:false`）。新增错误码 `INVALID_EMOTE`。
> 2. **未通关也能「结束本局」`game:end`**：`countdown` / `submitting` / `reveal` 阶段任一玩家可结束本局；服务端把当前对局冻结进 `lastGame` 快照（`result` 可为 `null`，表示还没揭晓），房间内部回 `lobby`，**双方都看到「本局结束」结算页**，可导出战报/再来一局。再次调用返回 `BAD_PHASE`。
> 3. **再来一局自动准备（纯前端）**：点过 `game:restart` 的一方，在对方也退出结算页（`settlePending` 变 false）后自动发 `player:ready`，双方都回来即自动开局。协议无变化。
> 4. **DOM**：新增 `#btn-end`、`#emote-row`、`#btn-emote-nudge` / `#btn-emote-thinking` / `#btn-emote-cheer`。
>
> **v3.3 变更（相对 v3.2）**：**协议事件与下发字段零变化**，只补可靠性、运维与 DOM 要求：
> 1. **离线兜底（关键）**：主动对局（countdown / submitting / reveal）中一方断线超过 `OFFLINE_ABORT_GRACE_MS = 120000`，服务端自动中止对局（`phase='aborted'`，在线方收到 `room:error {code:'OPPONENT_LEFT'}`）。解决「不限时房间对方掉线后永久卡在 submitting」。
> 2. **结算页离线解锁**：留守结算页的玩家断线超过 `SETTLE_OFFLINE_GRACE_MS = 60000`，服务端自动置其 `settleDismissed=true`（必要时清 `lastGame`），让已点「再来一局」的人能正常准备。解决「对方关页面后自己永远开不了新局」。
> 3. **关停通知**：服务端关闭前向所有房间广播 `room:notice {kind:'system', text:'服务器正在重启…'}`，客户端按既有 notice 逻辑 toast。
> 4. **运维**：所有 HTTP 响应带安全头（CSP / nosniff / frame / referrer / permissions）；`/assets/*` 带 `Cache-Control: immutable, max-age=1y`；其余静态资源保持 `max-age=0`。
> 5. **DOM**：新增 `#opponent-offline`（对局中对方掉线横幅）与 `#btn-copy-waiting`（等待时对方离线，复制邀请链接）；`#waiting-hint` 文案升级为「已提交，等对方 · 已等 m:ss（· 对方离线）」。
>
> **v3.2 变更（相对 v3.1）**：
> 1. **填词时限改为建房时由房主设定**：可选「不限时 / 1 分钟 / 3 分钟 / 5 分钟」，整局（含 `game:restart` 重开）固定，加入者不可改。`room:create` 新增可选 `submitLimitMs`；`PublicRoomState` 新增 `submitLimitMs`；`round:open.deadline` 在「不限时」时为 `null`；新增错误码 `INVALID_SUBMIT_LIMIT`。
> 2. **删除揭晓自动推进（原 `REVEAL_MS = 4500`）**：`round:reveal` 之后停在 reveal **无限等待**，只能由玩家发 `round:next` 进入下一轮；reveal 阶段 `deadline` 恒为 `null`，服务端不设该阶段计时器。
> 3. 相应删除 `PublicRoomState.revealFrozen`（自动推进已不存在，冻结状态失去意义）与 `round:agree` 的「首票取消计时器 / 冻结」规则。
>
> **v3.1 变更（相对 v3）**：新增**明暗主题**（默认跟随系统、兜底明亮、显式选择持久化）。
> 协议事件与字段零变化；新增 `#btn-theme` DOM id 与 §13 主题契约，`<html>` 上增加 `data-theme` / `data-theme-source` 两个属性。
>
> **v3 变更（相对 v2）**：技术栈升级，**协议本身零变化**——事件名、字段名、错误码、DOM id、状态机语义全部保持 v2。变化只在工程层：
> 1. 全部源码改为 TypeScript（ESM），后端 `tsc` 编译到 `dist/server`；
> 2. 前端由原生 JS 重写为 Vue 3 SFC（`<script setup lang="ts">`）+ Vite 构建到 `dist/public`；
> 3. 样式由纯 CSS 改为 Sass/SCSS（视觉 1:1 不变）；
> 4. 包管理器由 npm 换成 Yarn 1.22（`yarn.lock`，命令见 §2）。
> 5. 前后端共享的协议类型集中在 `src/shared/protocol.ts`（本文件的 TypeScript 映射，不得与本文档冲突）。
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
- **v3.2**：填词时限由房主创建房间时选定（不限时 / 1 分钟 / 3 分钟 / 5 分钟），整局固定。
- **v3.2**：揭晓后**不自动推进**，双方看完后点「进入下一轮」继续（不再有 4.5 秒自动跳转）。
- **v3.4**：提交后等待对方时可用**预设快捷表情**（催一下 / 还在想 / 加油），服务端 8s 限流；对局中任一玩家可随时「结束本局」，双方都进结算页并可导出战报；点过「再来一局」的人会在对方也退出结算后**自动准备**。
- **v2**：揭晓后若双方都确认「这两个词算同意词」→ 同样通关（`winBy: 'agree'`）。判定权在玩家，服务器不做任何语义判断。
- 整局通关后进入**结算视图**，展示最终成功的词与逐轮词语，支持导出一张整局词语列表图片。
- 房间 4 位码，昵称进入，无需注册/登录。只有「普通模式」。本地运行，单端口。
- 手机竖屏优先，桌面同样好看。

## 1. 技术栈与目录

- Node.js ≥ 20.19，Express 4 + Socket.IO 4，**TypeScript（ESM）**，后端用 `tsc` 编译到 `dist/server`。
- 前端 **Vue 3 SFC + TypeScript + Sass**，Vite 6 构建到 `dist/public`，由后端同进程静态托管；**不引入任何 CDN 资源**（离线可跑）。Socket.IO 客户端用服务端自动提供的 `/socket.io/socket.io.js`。
- 共享协议类型在 `src/shared/protocol.ts`（前后端唯一类型来源，形状严格等于本文件的 §5.3/§5.1）。
- 图片导出用浏览器原生 Canvas 2D，**不得引入任何第三方绘图库**。
- 包管理器 **Yarn 1.22**（`yarn.lock`；不再有 `package-lock.json`）。

```
src/server/index.ts    Express + Socket.IO 装配、HTTP 路由、静态资源
src/server/game.ts     房间与对局状态机（不依赖 socket，通过注入回调驱动）
src/shared/protocol.ts 前后端共享协议类型
src/web/index.html     Vite 入口
src/web/main.ts        createApp 挂载
src/web/App.vue        视图切换 + 全局层（toast/倒计时/撒花/音效/断线横幅）
src/web/components/    四视图（Home/Room/Game/Settle）与对局面板、玩家卡、历史等
src/web/composables/   socket / 会话状态 / 音效 / 倒计时 / 撒花
src/web/lib/           Canvas 导出海报、下载、存储、剪贴板、格式化
src/web/styles/        Sass 分片（variables/mixins/base/buttons/views/animations…）
tools/sim.ts           端到端测试：用 socket.io-client 起两个假玩家跑完整流程
.verify/ui-e2e.ts      真浏览器验收（Edge headless + CDP，Lead 维护）
vite.config.ts         前端构建配置（root=src/web → dist/public）
tsconfig.server.json   后端编译（NodeNext → dist/server）
tsconfig.app.json      前端类型检查（Bundler + vue-tsc）
tsconfig.tests.json    测试与验收脚本类型检查
Dockerfile             生产镜像（多阶段：builder 跑 yarn build，runtime 仅生产依赖、非 root、内置 /health 探活）
.dockerignore
docker-compose.yml     单实例编排（房间在内存，禁止扩副本）
```

**写入边界**：
- 后端只改 `src/server/**`、`tools/**`。
- 前端只改 `src/web/**`。
- `src/shared/protocol.ts`、`package.json`、`yarn.lock`、`tsconfig*.json`、`vite.config.ts`、`PROTOCOL.md`、`README.md`、`.verify/**`、`Dockerfile`、`.dockerignore`、`docker-compose.yml` 由 Lead 维护，前后端均不得改。

## 2. 运行

- 安装：`yarn install`（只用 yarn，不要用 npm 生成第二份 lockfile）。
- 开发：`yarn dev` —— 后端 `tsx watch src/server/index.ts`（3210）+ Vite dev server（5173，`/socket.io` 与 `/health` 代理到 3210）。
- 生产：`yarn build && yarn start` —— Vite 产出 `dist/public`、tsc 产出 `dist/server`，`node dist/server/index.js` 单进程托管。端口 `process.env.PORT || 3210`。
- `GET /health` → `{ "ok": true, "rooms": <房间数> }`
- 静态目录 `dist/public`，`GET /` 返回 `dist/public/index.html`。
- 未匹配的路由回落到 `index.html`（保证 `/?room=ABCD` 可用）。
- 服务端日志前缀统一为 `[同声传意]`。
- **v3.3 运维约定**：所有 HTTP 响应带安全头（CSP `default-src 'self'`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 关闭 camera/mic/geolocation）；`dist/public/assets/**` 由单独的静态路由提供，响应 `Cache-Control: public, max-age=31536000, immutable`（文件名带 hash，可放心长缓存）；`index.html` 等其余静态资源保持 `max-age=0`（每次校验）。
- **v3.3 关停**：SIGINT/SIGTERM 时先向所有房间广播关停 `room:notice`，延迟约 250ms 再 `io.close()`；最多 2 秒后进程退出。

## 3. 时间参数（v3.3）

```js
const COUNTDOWN_MS       = 3000;  // 3-2-1
const DEFAULT_SUBMIT_MS  = 60000; // 建房未指定 submitLimitMs 时的默认填词时限（1 分钟）
const SUBMIT_LIMIT_OPTIONS = [0, 60000, 180000, 300000]; // 0=不限时，其余=1/3/5 分钟
const START_DELAY        = 300;   // 双方准备后稍等再倒计时
const SETTLE_OFFLINE_GRACE_MS = 60000;  // v3.3：留守结算页的人离线多久后视为已退出
const OFFLINE_ABORT_GRACE_MS  = 120000; // v3.3：主动对局中一方离线多久后中止对局
const EMOTE_COOLDOWN_MS       = 8000;   // v3.4：快捷表情每人冷却
```

**v3.2 规则**：
- **填词时限是房间级参数**：创建房间时由房主在 `room:create` 里通过 `submitLimitMs` 指定（必须在 `SUBMIT_LIMIT_OPTIONS` 内，缺省 `DEFAULT_SUBMIT_MS`），非法值返回 `INVALID_SUBMIT_LIMIT`。整局（多轮之间、`game:restart` 重开后）保持不变，加入者不能修改。
- **没有「揭晓停留」计时器**：非通关时服务端进入 `reveal` 后 `deadline = null`，且不设任何 timer，无限等待，直到任一玩家发 `round:next` 才进入下一轮（3s 倒计时）。
- **「不限时」（`submitLimitMs = 0`）**：`round:open` 的 `deadline = null`，服务端不设提交超时计时器，只有双方都 `round:submit` 才揭晓。**v3.3 补丁**：这不是无限兜底——主动对局中一方断线超过 `OFFLINE_ABORT_GRACE_MS` 会中止对局（见 §8）；双方都在线时仍不限时。
- **计时的房间**：`round:open` 时 `deadline = 服务端 now + submitLimitMs`；到点后仍未提交的座位自动填 `{word:'词穷', timedOut:true}`，随后照常揭晓。
- 旧版 `SUBMIT_MS` / `REVEAL_MS` 常量**删除**，不再有 60s 固定时限与 4.5s 揭晓停留。

**v3.3 离线规则**（由 `sweep()` 周期扫描执行，扫描间隔 30s）：
- 主动对局（`countdown` / `submitting` / `reveal`，2 人房）中任一玩家 `connected=false` 且离线时长 ≥ `OFFLINE_ABORT_GRACE_MS` → 中止对局：`phase='aborted'`、`deadline=null`、清空 submissions 与结算快照，仍在线的一方收到 `room:error {code:'OPPONENT_LEFT'}`，随后广播 state。
- 结算页（`room.lastGame` 存在）中未退出结算页的玩家 `connected=false` 且离线时长 ≥ `SETTLE_OFFLINE_GRACE_MS` → 自动置 `settleDismissed=true`；当所有玩家都已退出 → `lastGame=null`；仍在线的人收到 `room:notice {kind:'system', text:'对方离线太久，已自动退出结算页'}`。离线玩家重连后看到的是真实 lobby（不会再回到结算页）。
- 断线后重连（带 token `room:join`）会清除离线计时，因此短暂掉线/切后台不会被误判。

## 4. 服务端数据模型（内部，不下发）

```js
Room {
  code: string,            // 4 位，字符集 A-Z2-9，排除 0/O/1/I
  phase: 'lobby'|'countdown'|'submitting'|'reveal'|'won'|'aborted',
  round: number,           // 当前/即将进行的轮次，从 1 开始
  basis: {a,b}|null,       // 本轮联想依据；第 1 轮为 null
  players: [Player],       // 最多 2 个，按加入顺序 seats = ['a','b']
  submissions: {a:Sub|null, b:Sub|null},  // Sub = {word, timedOut}
  submitLimitMs: number,           // v3.2：房间级填词时限，0 = 不限时；创建后整局不变
  agree: {a:boolean, b:boolean},   // v2：本轮同意词投票，进入新一轮/倒计时时全部清零
  lastGame: Snapshot|null,         // v2.1：整局结束后的冻结快照，供未退出结算页的玩家继续 won 视角
  result: Result|null,
  history: [HistoryItem],
  timer: Timeout|null,     // 当前阶段唯一计时器
  createdAt: number
}
Snapshot { round, basis:{a,b}|null, history:[HistoryItem], result:Result|null, endedAt:number } // v3.4：result 可为 null（未揭晓时结束本局）
Player { token, name, seat, socketId, ready, connected, isHost, settleDismissed:boolean, offlineAt:number|null, lastEmoteAt:number|null } // v3.3：offlineAt 仅内部；v3.4：lastEmoteAt 用于表情冷却
Result  { round, words:{a,b}, isWin, timedOut:{a,b}, agree:{a,b}, winBy:'same'|'agree'|null }
HistoryItem { round, basis:{a,b}|null, words:{a,b}, isWin, agree:{a,b}, winBy:'same'|'agree'|null }
```

## 5. 事件协议

所有「客户端 → 服务端」的请求都通过 ack 回调返回结果：

```js
socket.emit('room:create', { name, token?, submitLimitMs? }, (res) => { ... })
// 成功: { ok: true, ...字段 }
// 失败: { ok: false, error: 'ERROR_CODE', message: '中文提示' }
```

### 5.1 客户端 → 服务端

| 事件 | 请求体 | ack 成功返回 | 说明 |
|---|---|---|---|
| `room:create` | `{name, token?, submitLimitMs?}` | `{ok, code, token, seat:'a'}` | 建房，创建者即 seat a / host。`submitLimitMs` 必须在 `SUBMIT_LIMIT_OPTIONS` 内，缺省 `DEFAULT_SUBMIT_MS`；非法值 → `INVALID_SUBMIT_LIMIT` |
| `room:join` | `{code, name, token?}` | `{ok, code, token, seat, state}` | 加入或**断线重连**：若 token 命中房间内已有玩家 → 恢复该玩家（任意 phase 都允许） |
| `room:leave` | `{}` | `{ok:true}` | 主动离开 |
| `player:ready` | `{ready:boolean}` | `{ok:true}` | 仅 lobby 阶段有效 |
| `round:submit` | `{word:string}` | `{ok:true, submitted:true}` | 仅 submitting 阶段；**不得**在返回或广播里泄露对方已提交的内容 |
| `round:agree` | `{agree:boolean}` | `{ok:true, agree:{a,b}, winBy:'agree'\|null}` | **v2**。仅 reveal 阶段有效。为本人投/撤「这两个词算同意词」。`agree` 缺省视为 `true`。两票齐 → 立即通关（`winBy:'agree'`）。幂等：重复投同一方向不报错 |
| `round:next` | `{}` | `{ok:true}` | reveal 阶段：进入下一轮。v3.2 起**这是离开 reveal 的唯一方式**（不再自动推进） |
| `room:emote` | `{kind:'nudge'\|'thinking'\|'cheer'}` | `{ok:true, accepted:boolean}` | **v3.4**。仅 `submitting` 阶段有效（否则 `BAD_PHASE`）；`kind` 必须在 `EMOTE_KINDS` 内（否则 `INVALID_EMOTE`）。服务端按 `EMOTE_COOLDOWN_MS=8000` 限流；对方离线或冷却中 `accepted:false`（不发送）。成功时向对方定向发 `room:notice {kind:'info', text}`，文案由服务端生成（含发送者昵称），**不接受自由文本**。发送者不回显 |
| `game:end` | `{}` | `{ok:true}` | **v3.4**。仅 `countdown` / `submitting` / `reveal` 阶段有效（否则 `BAD_PHASE`）。把当前对局冻结进 `lastGame`（未揭晓时 `result=null`）并把房间内部重置为 `lobby`；**双方都保持 `settleDismissed=false`**，因此两人都会进入「本局结束」结算页（`phase:'won'` 视角）。随后可用 `game:restart` 各自退出并再来一局。幂等：内部已是 lobby 时再调 → `BAD_PHASE` |
| `game:restart` | `{}` | `{ok:true, watching:boolean}` | won 阶段：**本人**退出结算页回到 lobby（round=1, basis=null, history=[], ready 全 false, result=null, agree 全 false；`submitLimitMs` 保持不变）。若对方还留在结算页，服务端把整局冻结成 `lastGame` 快照继续为 TA 呈现 won 视角（见 §5.3.1）。对方也已退出时 `lastGame` 才置 null。**v3.4**：前端在本人点过 restart 后，等对方也退出结算页会自动发 `player:ready` |

`room:join` 规则优先级：
1. `token` 命中房间内已有玩家 → 重连（新 socketId 顶替旧的，旧连接收到 `room:error {code:'REPLACED'}` 并被移出房间频道）。
2. 房间不存在 → `ROOM_NOT_FOUND`。
3. 房间已有 2 人 → `ROOM_FULL`。
4. phase !== 'lobby' → `ROOM_IN_PROGRESS`。
5. 否则以 `seat:'b'` 加入。

`round:agree` 细则（v3.2 起投票不再影响自动推进，reveal 本来就不会自动推进）：
- 仅 `phase === 'reveal'` 允许，否则 `BAD_PHASE`；不在房间 `NOT_IN_ROOM`。
- 只接受 `true|false`（`Boolean` 归一），无长度/内容入参。
- 投票只记录票面并广播 state（`reveal.deadline` 恒为 `null`，无需清理任何计时器）。
- 两票都为 `true` 时（顺序无所谓，后到的一票触发）：
  - `result.isWin = true`、`result.winBy = 'agree'`、`result.agree = {a:true,b:true}`；
  - **同步更新本轮 history 末项**的 `isWin=true / winBy='agree' / agree={a:true,b:true}`（结算与导出图依赖 history）；
  - `phase = 'won'`、`deadline = null`；
  - 广播 `room:notice {kind:'system', text:'双方都确认是同意词，通关！'}`，随后按接收者视角 `room:state`。
  - **不再重发 `round:reveal`**（前端以 state 为准渲染 won）。
- 撤票（`agree:false`）：仅在自己已是 `true` 时把本座位清零。
- 双方都是 `true` 之后不允许再撤（已 `won`，返回 `BAD_PHASE`）。
- 超时自动填的「词穷」同样可以投同意词票（判定权在玩家）。

`room:emote` 细则（v3.4）：
- 仅 `phase === 'submitting'` 允许，否则 `BAD_PHASE`；不在房间 `NOT_IN_ROOM`。
- `kind` 只接受 `EMOTE_KINDS = ['nudge','thinking','cheer']`，其它值（含自由文本、超长字符串）一律 `INVALID_EMOTE`。
- 冷却：同一玩家两次成功发送之间至少间隔 `EMOTE_COOLDOWN_MS`（8s）；冷却中返回 `{ok:true, accepted:false}`（不是错误，前端提示「别催太急」）。
- 对方不存在或 `connected===false` → `{ok:true, accepted:false}`，不发送。
- 成功：向**对方**定向发 `room:notice {kind:'info', text}`，文案预设（含发送者昵称）：
  `nudge` → `${name} 催你啦：快一点～`、`thinking` → `${name} 说：还在想，别急～`、`cheer` → `${name} 给你加油：稳住！`。发送者不回显（前端本地 toast）。
- **硬约束**：绝不支持自由文本/自定义表情——双盲阶段任何文字都可能暗示自己的词，破坏公平。

`game:end` 细则（v3.4）：
- 仅 `countdown` / `submitting` / `reveal` 允许，否则 `BAD_PHASE`；不在房间 `NOT_IN_ROOM`。
- 执行顺序：`_clearTimer` → 冻结 `lastGame = { round, basis, history, result: 公开后的当前 result（未揭晓时为 null）, endedAt }` → 房间内部重置为 `lobby`（`round=1`、`basis=null`、`submissions/agree/result/history` 清空、`deadline=null`、所有 `players.ready=false`）→ **所有玩家 `settleDismissed` 保持 `false`** → 广播 `room:notice {kind:'system', text:'本局已结束，双方都可以查看战报并再来一局'}` → `room:state`。
- 因为 `lastGame && !settleDismissed`，双方 `getState` 都得到 won 视角，渲染同一个「本局结束」结算页（标题由 `winBy=null` 推导为「本局结束」，可能出现空的逐轮列表——第 1 轮还没揭晓就结束是正常的）。
- 结束后的退出/再来一局完全复用 §5.3.1 的各自退出机制。
- 幂等：内部已是 `lobby` 后再调 `game:end` → `BAD_PHASE`。

### 5.2 服务端 → 客户端（都发到房间频道）

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `room:state` | `PublicRoomState`（见 §5.3，**按接收者视角生成**） | 任何状态变化后、加入后、重连后 |
| `round:countdown` | `{round, basis, seconds:3}` | 进入 countdown 阶段 |
| `round:open` | `{round, basis, deadline}` | 倒计时结束、输入开放；`deadline = 服务端 now + submitLimitMs`（本房间不限时则为 `null`，无超时计时器） |
| `round:opponent-submitted` | `{}` | 对方已提交（仅提示，不含文字） |
| `round:reveal` | `{round, basis, words:{a,b}, isWin, timedOut:{a,b}, agree:{a,b}, winBy, history}` | 双方都提交（或计时房间到点自动提交）后，**同时**揭晓。此刻 `agree` 必为 `{a:false,b:false}`、`winBy` 为 `'same'` 或 `null`。v3.2 起揭晓后不自动推进 |
| `room:notice` | `{text:string, kind:'join'\|'leave'\|'info'\|'system'}` | 有人进出、同意词通关、快捷表情（v3.4，定向给接收方）、本局结束（v3.4）等提示，前端做 toast |
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
  submitLimitMs: 60000,                         // v3.2：房间级填词时限（毫秒），0 = 不限时
  deadline: 1761882000000 | null,               // 服务端毫秒时间戳；null 表示无倒计时
  result: {
    round, words:{a,b}, isWin, timedOut:{a,b},
    agree:{a,b},                                // v2
    winBy: 'same'|'agree'|null                  // v2
  } | null,
  history: [ { round, basis:{a,b}|null, words:{a,b}, isWin, agree:{a,b}, winBy } ]
}
```

`deadline` 语义：countdown = 倒计时结束时刻；submitting = 提交截止（**不限时房间为 `null`**）；reveal = **恒为 `null`**（v3.2 起揭晓后不自动推进）；won / lobby / aborted 恒为 `null`。

`state.phase === 'won'` 且 `settlePending === true` 有两种来源：正常通关，或 v3.4 的「结束本局」。后者 `result` 为冻结时的非通关结果，或为 `null`（在 countdown/submitting 阶段就结束）；前端结算页/导出图必须能处理 `result=null` 与空历史（标题显示「本局结束」）。

`agree` 视角说明：`agree.you` 是本人本轮投票，`agree.opponent` 是对方是否已投票。**绝不**因为对方投了票就泄露任何文字内容（此阶段词本来就已公开，无额外风险）。

**v2 已确认语义（Lead 裁定）**：reveal 期间 `result.agree` 实时镜像当前票面（例如 A 投了就是 `{a:true,b:false}`），但 `result.isWin` / `result.winBy` 在两票齐之前**不变**（仍是 `false` / `null`）；两票齐后才是 `{a:true,b:true}` + `isWin:true` + `winBy:'agree'`。前端渲染投票区应以 `state.agree.{you,opponent}` 为准，`result.agree` 只是同一事实的座位视角副本，可用于结算与导出图。

### 5.3.1 结算页的「各自退出」（v2.1，替代旧裁定）

旧裁定「restart 立即清空、重开后不能回看」**作废**。新语义：

> 一方点「再来一局」只让**自己**回到准备页；另一方**不被强制退出**，可以继续停留在结算页查看、导出，直到 TA 自己也点「再来一局」。

实现口径（服务端负责，前端几乎不改）：

- Room 新增 `lastGame: Snapshot | null`，`Snapshot = { round, basis, history, result, endedAt }`（`history`/`result` 形状与 §5.3 完全一致，前端结算/导出可直接复用；**v3.4 起 `result` 可为 `null`**——在未揭晓阶段结束本局时没有当前轮结果）。
- Player 新增 `settleDismissed: boolean`（本玩家是否已退出结算页）。存在玩家对象上，所以**断线重连后仍保持**在结算页。
- `game:restart` 语义变为「我退出结算页」：
  1. 首次有人退出（内部 `phase==='won'`）：先把整局冻结进 `lastGame`，再把房间内部重置为 `lobby`（`round=1`、`basis=null`、`submissions/agree/result/history` 清空、`deadline=null`、所有 `ready=false`——与旧行为相同），并置**点击者** `settleDismissed=true`、其余人 `false`。
  2. 后续有人退出（内部已是 `lobby`）：只把自己 `settleDismissed=true`；当**房间内所有玩家**都已退出 → `lastGame=null`。
- **v3.3 离线解锁（关键）**：留守结算页的玩家（`settleDismissed===false`）断线超过 `SETTLE_OFFLINE_GRACE_MS`（60s）后，`sweep()` 自动把它当作已退出：置 `settleDismissed=true`；若所有玩家都已退出则 `lastGame=null`；仍在线的人收到系统 notice「对方离线太久，已自动退出结算页」。这样已点「再来一局」的人不会被关页面走人的对方永久锁在准备页。离线者重连后看到真实 lobby（不再回到结算页）。
- **v3.4 结束本局复用同一机制**：`game:end` 冻结快照后让所有人保持 `settleDismissed=false`，因此双方同时进入结算页；之后各自 `game:restart` 退出，与通关后的流程完全一致（含离线解锁兜底）。
- **视角门控（关键）**：`getState(room, player)` 里，若 `room.lastGame && !player.settleDismissed`，则该玩家看到的 state 为「won 视角」：`phase:'won'`、`round/basis/history/result` 全部取自 `lastGame`、`deadline:null`、`submitted` 与 `agree` 全 false（`submitLimitMs` 仍下发房间真实值）。已退出的人看到真实房间状态。因此前端**仍然只按 `state.phase` 决定渲染哪一屏**，不需要新增分支。
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

`INVALID_NAME`(昵称为空/超 12 字) `INVALID_CODE` `ROOM_NOT_FOUND` `ROOM_FULL` `ROOM_IN_PROGRESS` `NOT_IN_ROOM` `BAD_PHASE` `INVALID_WORD`(空或超 12 字) `INVALID_SUBMIT_LIMIT`(填词时限不在 `SUBMIT_LIMIT_OPTIONS` 内) `INVALID_EMOTE`(表情不在 `EMOTE_KINDS` 内) `REPLACED` `OPPONENT_LEFT` `ROOM_DELETED` `INTERNAL`

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
lobby --(两人 ready, 延迟 300ms)--> countdown(3s) --> submitting(≤submitLimitMs；不限时则无上限)
submitting --(两人都提交 / 计时房间到点自动填「词穷」)--> [判定]
   ├─ 归一化相同 --> won（winBy='same'，发 round:reveal, phase=won, 无计时器）
   └─ 不同     --> reveal（v3.2：deadline=null、无计时器，无限等待）
reveal --(round:next，任一玩家)--> countdown(下一轮) 立即
reveal --(双方都 round:agree=true)--> won（winBy='agree'，更新 history 末项，room:notice）
countdown|submitting|reveal --(game:end，任一玩家)--> won 视角（v3.4：冻结 lastGame，双方都进结算页；内部 phase=lobby）
won --(game:restart)--> lobby（清空 history/result/ready/agree；submitLimitMs 保留；整局冻结进 lastGame 供未退出者继续看）
won --(一方已 restart，另一方仍在结算页)--> 内部已是 lobby，但留守者仍看到 won 视角（§5.3.1）
lobby --(双方都 restart 后，前端自动 player:ready)--> 双方 ready → 自动开局（v3.4，纯前端行为）
```

- 进入下一轮时：`round += 1`，`basis = 本轮 words`，清空 submissions，`agree = {a:false,b:false}`，`phase='countdown'`。
- `_startCountdown` 与 `_advanceRound` 都必须清零 `agree`（同一局多轮之间投票不串轮）。
- 每次相位变化都要 `room:state` 广播；除 `round:countdown` / `round:open` 外不要用其他事件改相位。
- 每个房间同一时刻只有一个 `timer`，切换相位前必须 `clearTimeout`；**reveal 阶段不设 timer**。

## 8. 断线 / 离开

- socket 断开：玩家标记 `connected:false` 并记录 `offlineAt`，广播 state；房间保留。对局继续（计时房间仍按超时自动提交兜底）。
- **v3.3 离线兜底**：主动对局（`countdown` / `submitting` / `reveal`）中一方离线 ≥ `OFFLINE_ABORT_GRACE_MS`（120s）→ 对局中止：`phase='aborted'`、`deadline=null`、清空 submissions 与结算快照，仍在线的一方收到 `room:error {code:'OPPONENT_LEFT', message:'对方掉线太久，这局结束了'}`。这是「不限时」房间不能永久卡在 submitting 的最终保底。
- **v3.3 结算页离线解锁**：结算页留守者离线 ≥ `SETTLE_OFFLINE_GRACE_MS`（60s）→ 自动退出结算页（细则见 §5.3.1）。
- **重连**：带 token `room:join` 命中房间内玩家 → 恢复座位并清空 `offlineAt`；短暂掉线/切后台不会被离线兜底误判。
- 主动 `room:leave` 或双断线清理：若剩余 0 人 → 删除房间；剩余 1 人在进行中 → 该玩家收到 `room:error {code:'OPPONENT_LEFT'}`, `state.phase='aborted'`。
- host 离开 → 剩余玩家 `isHost=true`。
- 空房间 / 全员离线超 10 分钟：清理（周期扫描）。
- reveal 等待期间对方离开：同样走 `aborted`。
- **v3.3 关停通知**：进程收到 SIGINT/SIGTERM 时先向所有房间广播 `room:notice {kind:'system', text:'服务器正在重启，本局会中断，稍后刷新重开一局'}`，约 250ms 后再关闭 socket 连接（见 §2）。

## 9. 必须存在的 DOM id（自动化验收用，前端不得改名）

```
#view-home  #view-room  #view-game
#nickname-input  #btn-create  #code-input  #btn-join
#room-code  #btn-copy  #btn-ready  #btn-leave-room
#basis  #word-input  #btn-submit  #waiting-hint
#reveal-a  #reveal-b  #reveal-verdict  #toast  #history
#timer  #timer-text
```

**v3.2 新增（填词时限）**：

```
#submit-limit-group   首页创建房间的时限选择组（role=radiogroup；四个选项按钮带 data-limit-ms="0|60000|180000|300000"，选中态 class is-active / aria-checked=true）
#room-limit           房间页展示「本局填词时限：…」（加入者也能看到房主的设定）
```

**v3.3 新增（等待与离线）**：

```
#waiting-hint         等待提示（文案含「已提交，等对方 · 已等 m:ss」，对方离线时追加「 · 对方离线」）
#btn-copy-waiting     等待且对方离线时出现的「复制邀请链接，喊他回来」按钮
#opponent-offline     对局视图中对方掉线时的提示横幅（role=status、aria-live=polite；对方重连后消失）
```

**v3.4 新增（快捷表情与结束本局）**：

```
#emote-row            对局视图中 submitting 阶段且对方在线时出现的快捷表情行
#btn-emote-nudge      「催一下」按钮（class 含 emote-btn；冷却中 disabled）
#btn-emote-thinking   「还在想」按钮
#btn-emote-cheer      「加油」按钮
#btn-end              对局 topbar 中的「结束本局」按钮（v-if 相位为 countdown/submitting/reveal；二次确认时文案为「确认结束？」）
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

**v3.1 新增（明暗主题）**：

```
#btn-theme            主题切换按钮（所有视图都必须可见/可点；aria-pressed=当前是否深色，aria-label 描述下一动作）
```

`<html>` 上必须始终带有 `data-theme="light|dark"` 与 `data-theme-source="system|user"`（语义见 §13）。

## 10. 验收标准

1. `yarn test` 通过：`tools/sim.ts` 自起服务，两个 socket 客户端完成 创建→加入→双方 ready→收到 countdown→open→各自 submit→reveal 判定「不同」→`round:next` 进入下一轮→第二轮提交相同→won→restart→回 lobby；断言所有关键事件与字段，并断言「在对方提交前拿不到对方词」。
2. `yarn test` 额外覆盖 v2 同意词链路（v3.2 语义）：某轮判定「不同」→ A 投 `round:agree` → 断言 state 出现 `agree.you=true / agree.opponent=false / deadline=null`，且**永不自动推进**（等待一段时间仍停在 reveal、无 `round:countdown`/`round:open`）→ B 投 `round:agree` → 断言 `phase='won'`、`result.winBy='agree'`、`result.isWin=true`、`history` 末项 `isWin=true/winBy='agree'`、收到 `room:notice`。
3. `yarn test` 还需断言：撤票可把 `agree.you` 变回 `false`；`won` 阶段投 `round:agree` 返回 `BAD_PHASE`；进入新一轮后上一轮投票清零；`agree` 在非 reveal 阶段的 state 中恒为 `{you:false, opponent:false}`。
4. `yarn build && yarn start` 后 `GET /health` 返回 200，响应体形状不变。
5. 页面无 console 报错，`/?room=ABCD` 能预填房间码。
6. 手机 375px 宽无横向滚动、按钮可点；首页 `#submit-limit-group` 的 4 个时限选项在 375px 下不得溢出。
7. **回归（bug 4）**：完整跑一局至通关 → 点「再来一局」回到房间页 → `#btn-ready` 必须**没有** `is-busy` 类、`aria-busy` 已移除、`textContent` 为「准备」。任意一次 `#btn-ready` 点击之后（无论成功、失败、切页、断线重连）都不得残留 `is-busy`。
8. **结算与导出**：`phase==='won'` 时展示 `#view-settle`，`#settle-rounds` 至少列出所有已玩轮次；点 `#btn-export` 产出一张 PNG（`blob` 或 `dataURL`），文件名含房间码，页面上给出成功/失败提示，且**导出失败不得影响游戏继续**。
9. **结算页各自退出（v2.1）**：A 点 `game:restart` 后——A 立刻是 lobby 视角（能看准备页、能点准备），**B 仍是 won 视角**（`state.phase==='won'`、`history`/`result` 等于通关那一刻的快照、`deadline===null`），B 的 `history` 不得被清空、不得被换成新一轮的空数据；B 此时点 `player:ready` 必须 `BAD_PHASE`；B 留在结算页期间仍可导出图片且内容与被踢无关。B 再点 `game:restart` 后两人才都进 lobby，`lastGame` 置 null。断言 ack 的 `watching` 字段：A 那次为 `true`、B 那次为 `false`。另需覆盖：留守方**断线重连后仍在结算页**；一方在对方留守时 `room:leave` → 留守方脱离假 won（收到 `OPPONENT_LEFT`/`aborted`，`lastGame` 被清）。
10. **新房不得被结算锁定误伤（v2.1 回归）**：全新房间、从未打过一局时 `state.settlePending === false` 且所有 `players[].settleDismissed === false`，此时准备按钮**必须可用**、`player:ready` 必须成功、双方准备后必须进入 countdown。页面上 `#room-tip` 在真正出现留守者前不得显示「还在看结算」类文案。
11. **v3 工程层验收**：`yarn typecheck` 三套配置（server / app / tests）0 错误；`yarn build` 同时产出 `dist/server/index.js` 与 `dist/public/index.html`；仓库内不再有 `.js` 业务源码（除构建产物与配置）；`yarn verify:ui` 真浏览器验收全过，且 #reveal-verdict / #agree-hint / #submit-limit-group / #room-limit / #opponent-offline / #btn-copy-waiting / #btn-end / #emote-row 这些 DOM id 必须存在。
12. **明暗模式（v3.1）**：无存储时跟随系统 `prefers-color-scheme`；系统能力不可用（无 `matchMedia`）时**兜底明亮**；`#btn-theme` 单击切换并把 `321:theme` 写入 localStorage，刷新后保持；Shift+单击清除存储回到「跟随系统」；深浅两套主题的 `body` 背景色不同、正文与按钮文字对比度 ≥ 4.5:1；`<html data-theme>`、`data-theme-source` 与 `<meta name="theme-color">` 同步更新。
13. **填词时限（v3.2）**：`yarn test` 断言——默认创建（不传 `submitLimitMs`）时 `state.submitLimitMs===60000` 且 `round:open.deadline ≈ now+60000`；创建传 `180000` 时 `state.submitLimitMs===180000`、`round:open.deadline-now ∈ [170000,182000]`；非法值（如 `90000`、字符串）返回 `INVALID_SUBMIT_LIMIT`；传 `0` 时 `round:open.deadline===null`、等待一段时间仍停在 `submitting` 且不自动揭晓、双方提交后正常 `round:reveal`；`game:restart` 后新 lobby 的 `state.submitLimitMs` 与建房时一致。浏览器验收需覆盖：首页可选四种时限、房间页 `#room-limit` 显示正确、不限时房间 `#timer` 显示「不限时」且无进度条、揭晓后无自动跳转（停留超过原 4.5s 仍在 reveal，`#btn-next` 可手动进入下一轮）。
14. **离线兜底（v3.3）**：`yarn test` 断言——`disconnect` 后记录 `offlineAt`、带 token 重连后清空；`offlineAt` 回拨超过 `OFFLINE_ABORT_GRACE_MS` 后 `sweep()` → `phase='aborted'`、`deadline=null`、在线方收到 `room:error{code:'OPPONENT_LEFT'}`（未超时则相位不变）；A `game:restart` 后 B 断线、B 的 `offlineAt` 回拨超过 `SETTLE_OFFLINE_GRACE_MS` → `sweep()` 后 `B.settleDismissed=true`、`lastGame=null`、A 的 `player:ready` 成功（未超时仍被拒）；`Game.announceShutdown()` 对每个房间广播 `room:notice`。HTTP：`/health` 响应含 CSP（`default-src 'self'`）、`x-content-type-options: nosniff`、`referrer-policy: no-referrer`；生产构建下 `/assets/*` 的 `Cache-Control` 同时含 `immutable` 与 `max-age=31536000`。浏览器验收：提交后等待提示包含「等对方」与「已等 m:ss」；对手掉线后对局页出现 `#opponent-offline`。
15. **快捷表情与结束本局（v3.4）**：`yarn test` 断言——`room:emote` 在 submitting 阶段成功返回 `accepted:true` 且对方收到含昵称与「催你啦」的 `room:notice`；8s 内第二次 `accepted:false`；非法 `kind` 返回 `INVALID_EMOTE`；非 submitting 阶段返回 `BAD_PHASE`；对方离线返回 `accepted:false`。`game:end` 在 reveal 阶段成功后双方 state 变为 `phase='won'`、`settlePending=true`、`result.isWin=false`、history 保留；内部 `lastGame.result` 在未揭晓阶段结束时为 `null`；lobby/won 阶段调用返回 `BAD_PHASE`。浏览器验收：A 提交后点 `#btn-emote-nudge`，B 端 toast 出现「催你啦」；对局中 `#btn-end` 点两次（二次确认）后双方进入 `#view-settle` 且 `#settle-title` 为「本局结束」；随后双方各点 `#btn-restart`，**无需再点准备**即自动进入下一局倒计时（自动准备）。

## 11. 导出图片契约（纯前端）

- 数据来源只能是 `room:state` 里的 `code / players / history / result / round`，**不得**为此新增后端字段。
- 用 `document.createElement('canvas')` + 2D context 绘制，宽度 1080 逻辑像素（配合 `devicePixelRatio` 缩放，最终 PNG 宽度 ≥1080），高度按轮次自适应，轮次多时不得截断。
- 画面必须包含：标题「同声传意」、房间码、双方昵称、逐轮「第 N 轮：A 词 / B 词」（通关轮要标记通关方式）、最终成功的词、日期。
- **版式（竖版时间线）**：整体是竖向长图时间线——左侧一条时间轴 + 每轮一个圆形节点（节点内是轮次序号），右侧每轮一张卡片自上而下排列（卡内两个词分列，通关标记做成右上角胶囊，下方一行「联想依据」），底部是一张高亮的「最终成功的词」卡。**只改结构，配色/字体/发光沿用应用内暗色霓虹风格**（背景 `#0b1526→#060a12`、青 `#3ee6d6`、柠 `#d8ff5c`、粉 `#ff7ab6`）。轮次越多图越长（3 轮起即为高>宽的竖版）。
- 字体只用系统可用字体栈（含中文，例如 `"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`），不得联网取字体或图片。
- 优先 `canvas.toBlob → URL.createObjectURL → <a download>`；`toBlob` 或下载不可用时回落 `toDataURL`；再失败则 toast 明确提示。允许在 `navigator.share` / `ClipboardItem` 可用时追加「复制到剪贴板/系统分享」，但必须是**可选增强**，不可用时隐藏入口。
- 导出为一次性动作，按钮需防重复点击并有 loading/结果提示。

## 12. 按钮 loading 态清理（bug 4 的硬约束）

- 任何进入 loading 的按钮，**必须在渲染阶段按当前真实忙态重新赋值**（`classList.toggle('is-busy', busy)`，Vue 里就是在组件渲染期 / computed / watch 里按 ref 重刷），不能只依赖请求回调去移除。
- 理由：ack 回调到达时服务端可能已广播了新 phase，渲染走了别的分支，`is-busy` 就永久残留；而 CSS 里 `.btn.is-busy { color: transparent }` 会让按钮「没有文字 + 一直转圈」。
- 因此：房间视图必须显式清/设 `#btn-ready` 的 `is-busy` 与 `aria-busy`；对局面板必须对 `#btn-submit` 同理；回到 lobby、离开房间、`aborted`、重开、断线重连这几条路径都要把各自按钮的 loading 态归位。
- 新加的 `#btn-agree` / `#btn-export` / `#btn-next` / `#btn-restart` / `#btn-theme` / `#btn-end` 也必须遵守同一条规则；`#btn-emote-*` 冷却用原生 `disabled` 表示，不进 loading 态。

## 13. 明暗主题契约（v3.1）

- **状态只存在 HTML 上**：`<html data-theme="light|dark" data-theme-source="system|user">`。CSS 只认这两个属性；组件层不得各自维护主题状态（统一走 `src/web/composables/useTheme.ts` 单例）。
- **解析优先级**：
  1. `localStorage['321:theme']` 为 `'light' | 'dark'` → 用户显式选择（`source: 'user'`）；
  2. 否则跟随系统 `prefers-color-scheme`（`source: 'system'`）；
  3. 系统能力不可用（没有 `matchMedia` / 调用抛错 / `matches` 非布尔）→ **兜底明亮**；
  4. 存储里是其它任何值（手动改坏、旧版本残留）→ 视为「未选择」，回到 2。
- **持久化时机**：只有用户通过 `#btn-theme` 做出显式选择才写 `321:theme`；回到「跟随系统」时删除该键（不写 `'system'`）。
- **切换交互**（`#btn-theme`）：单击在明亮 / 深色之间翻转；**Shift + 单击**清除显式选择、回到「跟随系统」。图标表示**当前**主题（🌙 深色 / ☀️ 明亮），`aria-pressed` 表示当前是否深色，`aria-label` 描述**下一动作**。
- **跟随系统期间**必须监听 `matchMedia('(prefers-color-scheme: dark)')` 的 `change` 事件实时更新；一旦是显式选择，系统变化不再生效。
- **防闪烁**：`src/web/index.html` 在 `<head>` 的内联脚本里、首屏绘制前用同一套规则写入 `data-theme` / `data-theme-source`。规则或键名改动时必须同步该脚本与 `src/web/lib/theme.ts`（键名 `321:theme` 在两处硬编码，`storage.ts` 里有注释提醒）。
- **`<meta name="theme-color">`**：取当前主题下 `--bg-0` 的计算值（配色只在 SCSS 定义，TS 不复制调色板）。
- **CSS 侧约定**：`:root` 输出深色令牌；浅色令牌同时挂在 `:root[data-theme='light']` 与 `@media (prefers-color-scheme: light) { :root:not([data-theme]) }`（无 JS 时也能按系统走）；两套主题各自声明 `color-scheme`。
- **导出 PNG 不受主题影响**：始终使用 §11 的深色霓虹版式，保证分享图品牌一致。

## 14. 管理后台契约（v3.5）

### 14.1 定位与安全边界

- **路由**：`GET /admin`（与游戏共用同一份前端产物，服务端 SPA 回落返回 `dist/public/index.html`）。进入页面先显示**密钥门禁**，校验通过且 socket 连上 `/admin` 命名空间后才显示房间列表。
- **密钥来源**：唯一来源是服务端环境变量 `ADMIN_KEY`（进程环境变量优先，其次项目根目录 `.env`，由 `src/server/env.ts` 读取；模板见 `.env.example`）。**留空 = 管理后台禁用**：任何管理员握手一律被拒绝（`connect_error.message = 'ADMIN_AUTH_FAILED'`），服务端启动日志明确打印「管理后台未配置 ADMIN_KEY」，前端门禁在失败文案里提示检查 `.env`（为避免给攻击者额外的探测信息，禁用态与密钥错误共用同一错误码）。
- **鉴权方式**：独立 Socket.IO namespace `/admin`（常量 `ADMIN_NAMESPACE`），握手载荷 `auth: { key }`；服务端用**定时安全比较**校验，失败时 `connect_error.message = 'ADMIN_AUTH_FAILED'`；同一 IP 60 秒内失败 ≥ 10 次后返回 `'ADMIN_RATE_LIMITED'`（窗口内即使密钥正确也先拒绝，60 秒后恢复）。限流按握手直连 IP（`handshake.address`）计数；挂在 HTTPS 反代后所有请求共用反代出口 IP，建议同时在反代层做额外访问控制。
- **隔离性（硬约束）**：管理员 socket **永远不 join 任何 `room_*` 频道**，不占玩家席位、不触发 `room:notice`/`OPPONENT_LEFT`/`room:state` 广播。观战与终止房间对玩家协议只有一处可观察影响：终止房间时玩家收到既有 `room:error {code:'ROOM_DELETED'}`。
- **密钥落盘**：前端只在 `sessionStorage['321:admin-key']` 保存（刷新免重输、关标签页即失效）；**禁止**写 `localStorage`、URL、DOM 属性或日志。服务端启动日志只打印「管理后台已启用/未配置」，绝不打印密钥。生产环境必须部署在 HTTPS 反代之后。
- **数据边界**：观战视角与玩家 §5.3 同一原则——`submitted` 只下发布尔值，**揭晓前任何载荷都不得含词**；`result` / `history` 只在揭晓后（`reveal` / 结算快照）才有词。
- **类型来源**：`src/shared/admin.ts`（本节的 TypeScript 映射，字段名以本文件为准）。

### 14.2 事件（namespace `/admin`）

客户端 → 服务端（都带 ack；失败返回既有 `ActionError`，错误码复用 §5.4，如 `ROOM_NOT_FOUND`）：

| 事件 | 载荷 | ack 成功 |
| --- | --- | --- |
| `admin:rooms:request` | `{}` / `{activeOnly?:boolean}`（`activeOnly` 为预留字段，当前忽略） | `ActionResult<{ok:true, rooms:AdminRoomsPayload}>` |
| `admin:room:watch` | `{code}` | `ActionResult<{ok:true, detail:AdminRoomDetail}>` |
| `admin:room:unwatch` | `{code}` | `ActionResult<{ok:true}>` |
| `admin:room:delete` | `{code}` | `ActionResult<{ok:true, code:string}>` |

服务端 → 管理员：

| 事件 | 载荷 | 触发时机 |
| --- | --- | --- |
| `admin:rooms` | `AdminRoomsPayload` | 连接成功后立即推一次；之后每 ≤500ms 检查一次，**内容变化才推** |
| `admin:room:state` | `{code, detail, at}` | 被观战房间内容变化时推（≤500ms 内），同一内容不重复推 |
| `admin:room:closed` | `{code, reason:'deleted' \| 'expired'}` | 被观战房间被管理员终止/自然清理/玩家走光时推，随后该房间自动移出观战集合 |

`AdminRoomsPayload` / `AdminRoomSummary` / `AdminRoomDetail` 字段见 `src/shared/admin.ts`。补充语义：

- `at` 是**服务端生成时刻**，前端据此换算 deadline 倒计时（手机本地时钟可能不准）。
- `AdminRoomSummary.phase` 是房间**真实相位**；`settlePending=true` 表示挂着整局结算快照（`lastGame`），前端显示「结算中」。
- `AdminRoomDetail` 在 `settlePending=true` 时，`round` / `basis` / `result` / `history` 取**快照**值（与玩家 §5.3.1 的 won 视角一致），`submitted` / `agree` 恒为 false，`settleEndedAt` = 快照冻结时刻；否则取实时房间值，`settleEndedAt=null`。
- `deadline`：`countdown` = 倒计时结束时刻，`submitting` = 提交截止（本房间不限时为 null），其余为 null。
- 观战是**只读**的：管理后台不得伪造/发送任何玩家事件（`round:submit` 等）。

### 14.3 终止房间语义

`admin:room:delete {code}`：

1. 房间码大写归一后查找；不存在 → `{ok:false, error:'ROOM_NOT_FOUND'}`；格式非法 → `INVALID_CODE`；
2. 先给房间内**所有在线玩家**定向发 `room:error {code:'ROOM_DELETED', message:'房间已被管理员关闭'}`（玩家前端按既有逻辑 `teardown` 回首页）；
3. 清计时器、结算快照，把房间从内存删除（无需再广播 `room:state`）；
4. ack `{ok:true, code}`；所有正在观战该房间的管理员收到 `admin:room:closed {code, reason:'deleted'}`。

### 14.4 管理后台 DOM id（自动化验收用，前端不得改名）

```
#view-admin           管理后台根容器（<body data-view="admin">）
#admin-gate           密钥门禁面板（未登录时可见）
#admin-key-input      密钥输入框（type=password，autocomplete=off）
#btn-admin-login      「进入」按钮（提交中 disabled / aria-busy=true）
#admin-gate-error     门禁错误文案（role=alert；密钥错误/限流/未配置/断网均在此）
#admin-dashboard      登录后的面板
#admin-status         连接状态文案（已连接 / 连接中… / 已断线，role=status）
#btn-admin-refresh    手动刷新房间列表
#btn-admin-logout     退出登录（清 sessionStorage 并断开 socket）
#admin-room-count     房间数
#admin-player-count   在线管理面板统计的玩家数
#admin-room-list      房间列表容器
#admin-empty           空列表占位文案
#admin-room-detail    观战详情面板（选中房间后可见）
#btn-admin-back       返回房间列表
#admin-detail-code    详情里的房间码
#admin-room-closed    房间已关闭提示（收到 admin:room:closed 后显示）
```

列表行/操作按钮是**重复元素**，用 class + `data-code` 定位（不用重复 id）：

```
.admin-room-card      房间卡片，data-code="ABCD"
.btn-admin-watch      「观战」按钮，data-code="ABCD"
.btn-admin-delete     「终止房间」按钮，data-code="ABCD"（二次确认时文案「确认终止？」）
```

### 14.5 验收标准（追加到 §10）

16. **管理后台（v3.5）**：
    - `yarn test`：无 key / 错 key 连接被拒（`ADMIN_AUTH_FAILED`）；正确 key 连接成功并收到 `admin:rooms`；房间列表随建房/加入/离开实时更新（≤2s）；`admin:room:watch` ack 返回详情并持续收到 `admin:room:state`；`submitting` 阶段 `submitted` 布尔实时变化且载荷**不含词**，`reveal` 后 `result/history` 含词；`admin:room:delete` 后玩家收到 `ROOM_DELETED`、列表移除、观战方收到 `admin:room:closed`；重复删除返回 `ROOM_NOT_FOUND`；`admin:room:unwatch` 后不再收到该房间的 `admin:room:state`。
    - `yarn build && yarn start` 后 `GET /admin` 返回 200 且内容是 `dist/public/index.html`（SPA 回落）。
    - `yarn verify:admin`（真浏览器）：未登录只看到门禁；错误密钥显示错误；正确密钥进入列表；列表出现房间后点「观战」进入实时详情；「终止房间」二次确认后房间从列表消失、观战面板显示已关闭；刷新页面（同一标签页）仍保持登录（sessionStorage）。
    - **禁用态**：`ADMIN_KEY` 留空起服务时握手返回 `ADMIN_AUTH_FAILED`、启动日志明确提示未配置，`/admin` 门禁提示检查 `.env`，游戏页与 `/health` 不受影响（一次性手验，不强制自动化）。
