# 同声传意 · 联机版（TypeScript + Vue 3）

> 两个人各自想一个词，喊「3！2！1！」同时说出来；不一样就一起基于这两个词再联想——直到说出一模一样的词，或者双方都点头「这俩算同意词」。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js ≥ 20.19、Express 4、Socket.IO 4、**TypeScript**（ESM，`tsc` 编译到 `dist/server`） |
| 前端 | **Vue 3** SFC（`<script setup lang="ts">`）+ **Vite 6** + **TypeScript** + **Sass**（构建到 `dist/public`） |
| 测试 | `tsx` 直跑 `tools/sim.ts`（端到端）；`.verify/ui-e2e.ts`（Edge headless + CDP 真浏览器验收） |
| 包管理 | **Yarn 1.22**（`yarn.lock`） |

运行期只有一个 Node 进程、一个端口；房间数据全在内存，无数据库、无外部服务。

## 快速开始

```bash
yarn install

# 开发模式：后端 tsx watch(3210) + Vite dev server(5173)，/socket.io 自动代理
yarn dev

# 生产模式：构建前端+后端，然后单进程托管
yarn build
yarn start          # 打开 http://localhost:3210
```

- 第一个人填昵称 → **创建房间**，把房间里的大号房间码（或「复制邀请链接」）发给朋友。
- 第二个人打开链接（或输入房间码）→ **加入房间**。
- 两人都点 **准备好了**，游戏自动开始倒计时。
- 每轮双方同时输入、同时揭晓。词一样 → 通关；不一样 → 以这两个词为联想依据继续。

同一 Wi-Fi 下也可以直接让朋友访问 `http://<你的局域网IP>:3210/?room=房间码`。

## 玩法细节

1. **第 1 轮**：各自随手想一个词，同时提交。
2. **不相同**：双方都以【上一轮的两个词】为起点联想下一个词。
3. **相同**（忽略标点、空格、大小写、全半角）→ 通关，可以再来一局。
4. **同意词通关**：揭晓后如果不一样，任何一方都能点「我认为意思相同」。等**双方都确认**，这也算通关——判词同不同意由你们俩说了算，服务器不做语义判断。
5. 只要有人投了票，本轮就不再自动进下一轮（防止你正在犹豫就被推走），需要手动点「下一轮」才继续。

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

## 目录结构

```
src/
  server/index.ts     Express + Socket.IO 装配（静态资源 + socket 事件接线）
  server/game.ts      房间与对局状态机（与 socket 解耦，注入式传输层）
  shared/protocol.ts  前后端共享的协议类型（PROTOCOL.md 的 TypeScript 映射）
  web/                Vue 3 前端
    index.html        Vite 入口
    main.ts / App.vue 应用入口与视图切换
    components/       四视图 + 对局子面板 + 全局层（toast/倒计时/撒花/音效）
    composables/      socket / 会话状态 / 音效 / 倒计时 / 撒花
    lib/              Canvas 导出海报、下载、存储、剪贴板、格式化
    styles/           Sass 分片（variables/mixins/base/buttons/views/animations…）
tools/sim.ts          端到端自测：两个模拟客户端跑完整对局
.verify/ui-e2e.ts     真浏览器验收（Edge headless + CDP，零第三方依赖）
vite.config.ts        前端构建配置（root=src/web → dist/public，dev 代理 /socket.io）
tsconfig.json         基础编译配置
tsconfig.server.json  后端（NodeNext → dist/server）
tsconfig.app.json     前端（Bundler + vue-tsc）
tsconfig.tests.json   测试与验收脚本
PROTOCOL.md           前后端事件契约（唯一事实来源）
```

## 测试与验收

```bash
yarn test          # tools/sim.ts：自起临时服务（3299，不占 3210）跑完整对局
yarn typecheck     # tsc(server) + vue-tsc(app) + tsc(tests) 三套类型检查
yarn verify:ui     # 真浏览器验收：需先 yarn build && yarn start（Edge headless + CDP）
```

`tools/sim.ts` 会自己拉起一个临时服务，用两个 socket 客户端跑：建房 → 加入 → 双方准备 → 倒计时 → 双盲提交 → 揭晓 → 同意词投票 → 下一轮 → 通关 → 再来一局 → 断线重连，并断言「对方提交前拿不到对方的词」以及同意词链路的全部状态。

`.verify/ui-e2e.ts` 用 CDP 驱动真实 Edge 跑完整双人对局，覆盖：双盲、同意词投票冻结、结算导出 PNG、结算页各自退出、准备按钮 loading 残留回归、手机 375px 布局、明暗主题（跟随系统 / 兜底明亮 / 切换持久化 / 三态循环 / meta theme-color），截图落在 `.verify/shots/`（主流程固定系统深色，保证视觉基线稳定）。

## 用 Docker 部署（推荐）

镜像定义见 `Dockerfile`（多阶段：builder 用 `yarn build` 产出 `dist/`，runtime 只装生产依赖、非 root 运行、内置 `/health` 探活）。

### 1. 构建并启动

```bash
docker build -t syncmean:latest .
docker run -d --name syncmean \
  --restart unless-stopped \
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
2. **重启容器 = 清空所有房间**，正在进行的对局会断。更新选在人少的时候，玩家刷新页面重开一局即可（无数据库，也不需要挂数据卷）。

### 5. 更新版本

```bash
git pull
docker compose up -d --build   # 或重新 docker build + docker rm -f 旧容器
```

### 6. 国内构建 yarn 慢的话

```bash
docker build --build-arg YARN_REGISTRY=https://registry.npmmirror.com -t syncmean:latest .
```

### 7. 不想用 Docker

单进程、无数据库，任意能跑 Node 20.19+ 的机器都行：

```bash
yarn install
yarn build
PORT=8080 yarn start
```

## 可扩展方向

- 惩罚版（词不一样就「原地跑两步」）
- 观战席、观战弹幕
- 回合历史回放、最强联想词排行榜
- 词库提示 / 语音朗读倒计时
