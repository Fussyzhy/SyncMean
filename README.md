# 同声传意 · 联机版（TypeScript + Vue 3）

> 两个人各自想一个词，喊「3！2！1！」同时说出来；不一样就一起基于这两个词再联想——直到说出一模一样的词，或者双方都点头「这俩算同意词」。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js ≥ 20.19、Express 4、Socket.IO 4、**TypeScript**（ESM，`tsc` 编译到 `dist/server`） |
| 前端 | **Vue 3** SFC（`<script setup lang="ts">`）+ **Vite 6** + **TypeScript** + **Sass**（构建到 `dist/public`） |
| 测试 | `tsx` 直跑 `tools/sim.ts`（端到端）；`.verify/ui-e2e.ts` / `.verify/admin-e2e.ts`（Edge headless + CDP 真浏览器验收） |
| 管理后台 | `/admin`（独立 Socket.IO namespace `/admin`，`ADMIN_KEY` 密钥门禁，实时房间列表 / 观战 / 终止房间） |
| 包管理 | **Yarn 1.22**（`yarn.lock`） |

运行期只有一个 Node 进程、一个端口；房间数据全在内存，无数据库、无外部服务。

## 快速开始

```bash
yarn install

# 1) 配置环境变量（首次）：管理后台密钥写在 .env 里，模板见 .env.example
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
# 然后编辑 .env，把 ADMIN_KEY 换成自己的长随机串；不配也能正常玩游戏，只是 /admin 会被禁用

# 开发模式：后端 tsx watch(3210) + Vite dev server(5173)，/socket.io 自动代理
yarn dev

# 生产模式：构建前端+后端，然后单进程托管
yarn build
yarn start          # 打开 http://localhost:3210
```

- 第一个人填昵称 → **创建房间**（可以顺便选本局「填词时限」：不限时 / 1 分钟 / 3 分钟 / 5 分钟），把房间里的大号房间码（或「复制邀请链接」）发给朋友。
- 第二个人打开链接（或输入房间码）→ **加入房间**（能在准备页看到房主选的填词时限）。
- 两人都点 **准备好了**，游戏自动开始倒计时。
- 每轮双方同时输入、同时揭晓。词一样 → 通关；不一样 → 以这两个词为联想依据继续；看完揭晓点「进入下一轮」再继续。
- 管理后台：浏览器打开 `http://localhost:3210/admin`，输入 `.env` 里的 `ADMIN_KEY` 进入（详见下方「管理后台」）。

同一 Wi-Fi 下也可以直接让朋友访问 `http://<你的局域网IP>:3210/?room=房间码`。

## 玩法细节

1. **第 1 轮**：各自随手想一个词，同时提交。
2. **不相同**：双方都以【上一轮的两个词】为起点联想下一个词。
3. **相同**（忽略标点、空格、大小写、全半角）→ 通关，可以再来一局。
4. **同意词通关**：揭晓后如果不一样，任何一方都能点「我认为意思相同」。等**双方都确认**，这也算通关——判词同不同意由你们俩说了算，服务器不做语义判断。
5. **揭晓后不会自动进入下一轮**：双方看完揭晓后，任意一方点「进入下一轮」才开始下一轮倒计时（投票只影响是否通关，不影响推进）。
6. **填词时限由房主建房时选定**（不限时 / 1 分钟 / 3 分钟 / 5 分钟）：计时到点未提交会按「词穷」自动兜底；选「不限时」则不设截止时间，必须双方都提交才揭晓。
7. **掉线会兜底**：短暂断线可以带 token 自动重连；但主动对局中一方离线超过约 2 分钟，本局会自动中止（另一方收到提示）；结算页对方离线超过约 1 分钟，会自动视为「已退出结算页」，不会把你锁在准备页。
8. **快捷表情**：填词等待时能给对面发「催一下 / 还在想 / 加油」三个预设表情（8 秒冷却），只用来打招呼/催促，不开放自由聊天（避免暗示自己的词）。
9. **随时结束本局**：撞不上词或有人想收工，对局中任一玩家点「结束本局」（二次确认）即可结束，双方都会进入结算页，可以查看/导出战报，再点「再来一局」继续。
10. **再来一局自动准备**：点过「再来一局」后不用再点准备——等对方也退出结算页，双方会自动准备并开始下一局。

服务器采用**双盲提交**：一方提交后，另一方只能看到「对方已提交」的提示，永远看不到具体内容，保证公平。

## 结算

整局通关后进入结算页，可以看到：

- 最终成功的两个词与通关方式（一模一样 / 双方确认同意词）
- 每一轮各自说了什么、联想依据是什么
- 总轮次统计

点 **导出图片** 会把整局词语画成一张**竖版时间线长图**（每轮一张卡片 + 底部高亮的最终词卡）下载到本地，纯浏览器 Canvas 绘制，不上传、不依赖任何第三方库，可以直接发给朋友。

结算页是**各自退出**的：一方点「再来一局」只有自己回到准备页，另一方**不会被踢出**，可以继续翻看、导出这一局的结算内容，直到 TA 自己也点「再来一局」。两人都退出后，房间才真正开始下一局。

## 明暗模式

右上角的 🌙 / ☀️ 按钮切换明暗主题：

- **默认跟随系统** `prefers-color-scheme`（没做过选择时，系统切主题页面实时跟着变）；
- 系统能力不可用时（例如环境不支持 `matchMedia`）**兜底用明亮模式**；
- 手动切换后写入 `localStorage['321:theme']`，刷新/重开浏览器都保持；
- 单击在明亮 / 深色之间翻转；**Shift + 单击**清除记忆、回到「跟随系统」；
- 首屏有内联脚本提前写 `data-theme`，不会出现「先黑后白」的闪烁；`<meta name="theme-color">` 跟随主题变化；
- **导出图片不受主题影响**，始终是深色霓虹版式，保证分享图品牌一致。

技术约定见 [PROTOCOL.md §13](PROTOCOL.md#13-明暗主题契约v31)。

## 管理后台（v3.5）

浏览器打开 **`/admin`**，输入 `.env` 里的 `ADMIN_KEY` 密钥即可进入（密钥错误/次数过多会提示；同一标签页刷新不用重新输）。

- **实时房间列表**：房间码、相位、轮次、双方昵称/座位/在线状态、填词时限、等待/倒计时（服务端每 ≤500ms 有变化就推送一次，手机本地时钟不准也没关系）。
- **实时观战**：点房间里「观战」进入只读详情——倒计时、双方是否已提交、本轮联想依据、揭晓后的词与逐轮历史、同意词投票、结算快照。观战**只下发布尔提交状态，揭晓前绝不显示词**，也不会占座或打扰玩家。
- **终止房间**：点「终止房间」需二次确认，确认后房间内玩家会立即被提示「房间已被管理员关闭」并回到首页，房间从内存删除（计时器/结算快照一并清理）。
- **安全边界**：管理员走独立 Socket.IO namespace `/admin`，密钥只存在服务端环境变量 / 本地 `.env`，前端只放 `sessionStorage`，不进 URL/localStorage；生产环境请务必挂在 HTTPS 反代之后，并把 `ADMIN_KEY` 换成 16 位以上随机串。**未配置 `ADMIN_KEY` 时管理后台自动禁用**（握手一律被拒，门禁文案会提示检查 `.env`；服务端启动日志也会明确打印），不影响正常游戏。
- **运维提示**：改完 `.env` 的 `ADMIN_KEY` 必须重启服务才生效；登录失败限流按直连 IP 计（60 秒内 10 次），挂在反代后所有请求共用反代出口 IP，建议在反代层再加访问控制。

```bash
# 本地开发：改 .env 后重启 yarn dev
# Docker：通过环境变量注入（不要 baked 进镜像）
docker run -d -e ADMIN_KEY='你的密钥' -p 3210:3210 syncmean:latest
```

协议细节（事件、载荷、DOM id、验收标准）见 [PROTOCOL.md §14](PROTOCOL.md#14-管理后台契约v35)。

## 目录结构

```
src/
  server/index.ts     Express + Socket.IO 装配（静态资源 + socket 事件接线）
  server/game.ts      房间与对局状态机（与 socket 解耦，注入式传输层）
  server/env.ts       读取根目录 .env（进程环境变量优先）+ PORT / ADMIN_KEY 配置
  server/admin.ts     /admin 管理命名空间（密钥门禁 + 房间列表 / 观战 / 终止房间推送）
  shared/protocol.ts  前后端共享的协议类型（PROTOCOL.md 的 TypeScript 映射）
  shared/admin.ts     管理后台协议类型（PROTOCOL.md §14 的 TypeScript 映射）
  web/                Vue 3 前端
    index.html        Vite 入口
    main.ts / App.vue 应用入口与视图切换（/admin 时挂载 AdminApp）
    AdminApp.vue       管理后台（密钥门禁 → 房间列表 → 观战详情）
    components/       四视图 + 对局子面板 + 全局层（toast/倒计时/撒花/音效）
    components/admin/ 管理后台门禁 / 房间列表 / 观战详情
    composables/      socket / 会话状态 / 管理后台 socket / 音效 / 倒计时 / 撒花
    lib/              Canvas 导出海报、下载、存储、剪贴板、格式化
    styles/           Sass 分片（variables/mixins/base/buttons/views/admin…）
tools/sim.ts          端到端自测：两个模拟客户端 + 管理员客户端跑完整对局与后台流程
.verify/ui-e2e.ts     真浏览器验收（Edge headless + CDP，零第三方依赖）
.verify/admin-e2e.ts  管理后台真浏览器验收（门禁 / 列表 / 观战 / 终止）
vite.config.ts        前端构建配置（root=src/web → dist/public，dev 代理 /socket.io）
tsconfig.json         基础编译配置
tsconfig.server.json  后端（NodeNext → dist/server）
tsconfig.app.json     前端（Bundler + vue-tsc）
tsconfig.tests.json   测试与验收脚本
.env.example          环境变量模板（复制为 .env 后填写 ADMIN_KEY；.env 不入库）
PROTOCOL.md           前后端事件契约（唯一事实来源）
```

## 测试与验收

```bash
yarn test          # tools/sim.ts：自起临时服务（3299，不占 3210）跑完整对局 + 管理后台协议
yarn typecheck     # tsc(server) + vue-tsc(app) + tsc(tests) 三套类型检查
yarn verify:ui     # 真浏览器验收：需先 yarn build && yarn start（Edge headless + CDP）
yarn verify:admin  # 管理后台真浏览器验收：需先 yarn build && yarn start（Edge headless + CDP）
```

`tools/sim.ts` 会自己拉起一个临时服务，用两个 socket 客户端跑：建房 → 加入 → 双方准备 → 倒计时 → 双盲提交 → 揭晓 → 同意词投票 → 手动下一轮 → 通关 → 再来一局 → 断线重连，并断言「对方提交前拿不到对方的词」、同意词链路全部状态、房间级填词时限（缺省 1 分钟 / 自定义 / 不限时 / 非法值拒绝 / restart 后保持），以及快捷表情（白名单 / 冷却 / 离线不送达）与「结束本局」（未通关快照 / 双方结算 / 幂等）。**v3.5 追加**：管理员命名空间鉴权（无/错密钥拒绝、限流、正确密钥连通）、房间列表实时变化、观战状态下发（未揭晓不含词）、终止房间（玩家收到 `ROOM_DELETED`、列表移除、观战方收到 `admin:room:closed`）、`parseEnvText`/`loadEnvFile` 单测。

`.verify/ui-e2e.ts` 用 CDP 驱动真实 Edge 跑完整双人对局，覆盖：双盲、揭晓不自动推进、同意词投票、快捷表情送达与冷却、结束本局（二次确认后双方结算）、再来一局自动准备、结算导出 PNG、结算页各自退出、准备按钮 loading 残留回归、手机 375px 布局、首页填词时限选择与「不限时」房间行为、明暗主题（跟随系统 / 兜底明亮 / 切换持久化 / 三态循环 / meta theme-color），截图落在 `.verify/shots/`（主流程固定系统深色，保证视觉基线稳定）。

## 用 Docker 部署（推荐）

镜像定义见 `Dockerfile`（多阶段：builder 用 `yarn build` 产出 `dist/`，runtime 只装生产依赖、非 root 运行、内置 `/health` 探活）。

### 1. 构建并启动

```bash
docker build -t syncmean:latest .
docker run -d --name syncmean \
  --restart unless-stopped \
  -e ADMIN_KEY='换成你的管理后台密钥' \
  -p 3210:3210 \
  syncmean:latest
```

确认起来了：

```bash
curl -s http://127.0.0.1:3210/health   # {"ok":true,"rooms":0}
docker ps                              # STATUS 里应出现 (healthy)
docker logs -f syncmean                # [同声传意] 服务已启动：http://localhost:3210
```

> 如果你在自己电脑上（Windows/macOS）构建、再推到 Linux 服务器，记得指定平台：
> `docker buildx build --platform linux/amd64 -t 你的仓库/syncmean:v1 .`

### 2. 用 docker compose（推荐，配置写在文件里）

```bash
docker compose up -d --build   # 构建并后台启动
docker compose logs -f         # 看日志
docker compose down            # 停止并移除
```

> 管理后台密钥：`docker-compose.yml` 已把 `ADMIN_KEY` 透传给容器（`ADMIN_KEY: ${ADMIN_KEY:-}`）。
> Docker Compose 会自动读取项目根目录的 `.env` 做变量替换，所以在 `.env` 里填 `ADMIN_KEY=...` 再 `docker compose up -d` 即可；
> 也可以在启动前 `export ADMIN_KEY=...`（或在 compose 文件里直接写死）。`.env` 已在 `.dockerignore` 中，不会被打进镜像。

### 3. 对外暴露

- 小规模可以直接开防火墙端口访问 `http://服务器IP:3210`；
- 更推荐前面挂 Nginx / Caddy 做 80/443 + HTTPS。此时容器端口只绑本机即可：
  `-p 127.0.0.1:3210:3210`，或把 compose 里的 ports 改成 `"127.0.0.1:3210:3210"`。

**Socket.IO 必须让反代透传 WebSocket 升级**，否则会退化成轮询甚至连不上。Nginx 关键几行：

```nginx
location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 7d;   # WebSocket 长连接，别用默认 60s 被掐断
}
```

Caddy 更省事（自动 HTTPS，WebSocket 默认就支持）：

```
game.example.com {
    reverse_proxy 127.0.0.1:3210
}
```

### 4. 必须知道的两个限制

1. **只能跑 1 个副本。** 房间数据全在进程内存里（`src/server/game.ts` 的 `Map`），多副本/负载均衡会把同一房间的两个人分到不同进程，直接玩不了。要横向扩容得先加 `@socket.io/redis-adapter` + Redis + sticky session，本项目暂未做。
2. **重启容器 = 清空所有房间**，正在进行的对局会断。服务端关闭前会先给所有房间发一条「服务器正在重启」的提示，玩家刷新页面重开一局即可（无数据库，也不需要挂数据卷）。

### 5. 更新版本

```bash
git pull
docker compose up -d --build   # 或重新 docker build + docker rm -f 旧容器
```

### 6. 构建卡在 `yarn install` / 换下载源

**先分清「慢」和「卡死」**：日志里出现 `There appears to be trouble with your network connection. Retrying...` 时，如果它还能继续往前走（`[4/5] Linking dependencies...`、`[5/5] Building fresh packages...`），那就只是网速慢——Yarn 会对每个包超时重试，273 个包在低带宽下走几分钟很正常，等着就行，**不用中断重建**（中断反而重来）。实测一次 459s 的慢构建里，旧 Dockerfile 的 `[builder 5/8]` 与 `[runtime 5/6]` 两条 `yarn install` 是**并行**各拉一遍依赖，互相抢带宽，各自 440s 左右。真正卡死（超过 10 分钟毫无推进）才按下面排查。

**为什么会这样**：`yarn.lock` 里每个包的 `resolved` 都写死了绝对下载地址（本仓库是 `registry.npmmirror.com`）。Yarn 1 会优先按 lockfile 的 `resolved` 下载，所以 `yarn config set registry` 对已锁定的包**无效**——容器实际还是去 lockfile 写死的那个域名拉包。因此构建快慢取决于**构建机到那个域名的速度**：国内机器用 npmmirror 快，海外机器用官方源快。

现在 `Dockerfile` 已经处理：默认用 npmmirror（与锁文件一致），并按 `YARN_REGISTRY` 重写锁文件，换源真正生效；同时把超时放宽到 5 分钟（`YARN_NETWORK_TIMEOUT` 可调），并且**只有 builder 阶段联网一次**，runtime 阶段完全离线（生产依赖从构建缓存离线装好再拷进去）。

换官方源（构建机在海外时）：

```bash
docker build --build-arg YARN_REGISTRY=https://registry.npmjs.org -t syncmean:latest .
```

首次构建要下载全部依赖（几分钟到十几分钟都算正常）；**之后只改代码再构建会命中 `yarn install` 的层缓存，不会重新下载**。

还是卡的话，按顺序排查（都是容器内网络问题）：

```bash
# 1) 容器内 DNS 是否能解析
docker run --rm node:22-alpine sh -c "getent hosts registry.npmmirror.com || echo DNS-FAIL"

# 2) 容器内 HTTPS 能否拉包（能打印 200 就说明网络没问题）
docker run --rm node:22-alpine node -e "fetch('https://registry.npmmirror.com/express').then(r=>console.log('HTTP',r.status)).catch(e=>console.error('ERR',e.cause&&e.cause.code||e.message))"

# 3) 看真实错误（不要只看 BuildKit 的进度条）
docker build --progress=plain --no-cache -t syncmean:latest . 2>&1 | tail -n 120
```

`1)` 失败 → Docker Desktop 的 DNS 问题：重启 Docker Desktop，或在 Settings → Resources → Network 换 DNS；Linux 宿主可给 `dockerd` 配 DNS。
`2)` 失败但 1) 正常 → 多半是代理/VPN：Docker Desktop 在 Settings → Resources → Proxies 配置代理，或构建时传 `--build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...`；Linux 宿主可用 `docker build --network=host`。

### 7. 不想用 Docker

单进程、无数据库，任意能跑 Node 20.19+ 的机器都行：

```bash
yarn install
yarn build
PORT=8080 ADMIN_KEY='你的管理后台密钥' yarn start
```

（也可以把 `PORT` / `ADMIN_KEY` 写进项目根目录 `.env`，服务启动时会自动读取；进程环境变量优先级更高。）

## 可扩展方向

- 惩罚版（词不一样就「原地跑两步」）
- 玩家观战席、观战弹幕（管理员观战已在 v3.5 支持）
- 回合历史回放、最强联想词排行榜
- 词库提示 / 语音朗读倒计时
