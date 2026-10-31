# 同声传意 · 联机版

> 两个人各自想一个词，喊「3！2！1！」同时说出来；不一样就一起基于这两个词再联想——直到说出一模一样的词，或者双方都点头「这俩算同意词」。

## 快速开始

```bash
npm install
npm start
```

打开 <http://localhost:3210>。

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

## 目录结构

```
server.js           Express + Socket.IO 服务（静态资源 + 房间事件接线）
src/game.js         房间与对局状态机（与 socket 解耦）
tools/sim.js        端到端测试：两个模拟客户端跑完整对局
public/             前端四视图（首页 / 房间 / 对局 / 结算）
PROTOCOL.md         前后端事件契约（唯一事实来源）
```

## 测试

```bash
npm test
```

`tools/sim.js` 会自己拉起一个临时服务（不占用 3210），用两个 socket 客户端跑：建房 → 加入 → 双方准备 → 倒计时 → 双盲提交 → 揭晓 → 同意词投票 → 下一轮 → 通关 → 再来一局 → 断线重连，并断言「对方提交前拿不到对方的词」以及同意词链路的全部状态。

## 用 Docker 部署（推荐）

镜像定义见仓库根目录的 `Dockerfile`（基于 `node:22-alpine`，只装生产依赖，非 root 用户运行，内置 `/health` 探活）。

### 1. 在服务器上构建并启动

服务器装好 Docker 后，把项目放上去（`git clone` 或 `scp`），然后：

```bash
cd tongshengchuanyi
docker build -t tongshengchuanyi:latest .
docker run -d --name tongshengchuanyi \
  --restart unless-stopped \
  -p 3210:3210 \
  tongshengchuanyi:latest
```

确认起来了：

```bash
curl -s http://127.0.0.1:3210/health   # {"ok":true,"rooms":0}
docker ps                              # STATUS 里应出现 (healthy)
docker logs -f tongshengchuanyi        # [同声传意] 服务已启动：http://localhost:3210
```

> 如果你在自己电脑上（Windows/macOS）构建、再推到 Linux 服务器，记得指定平台：
> `docker buildx build --platform linux/amd64 -t 你的仓库/tongshengchuanyi:v1 .`

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

**Socket.IO 必须让反代透传 WebSocket 升级**，否则会退化成轮询甚至连不上。Nginx 关键三行：

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

1. **只能跑 1 个副本。** 房间数据全在进程内存里（`src/game.js` 的 `Map`），多副本/负载均衡会把同一房间的两个人分到不同进程，直接玩不了。要横向扩容得先加 `@socket.io/redis-adapter` + Redis + sticky session，本项目暂未做。
2. **重启容器 = 清空所有房间**，正在进行的对局会断。更新选在人少的时候，玩家刷新页面重开一局即可（无数据库，也不需要挂数据卷）。

### 5. 更新版本

```bash
git pull
docker compose up -d --build   # 或重新 docker build + docker rm -f 旧容器
```

### 6. 国内构建 npm 慢的话

在 `Dockerfile` 的 `RUN npm ci` 前加一行换源：

```dockerfile
RUN npm config set registry https://registry.npmmirror.com
```

### 7. 不想用 Docker

单进程、无数据库、无构建步骤，任意能跑 Node 18+ 的机器都行：

```bash
PORT=8080 npm start
```

## 可扩展方向

- 惩罚版（词不一样就「原地跑两步」）
- 观战席、观战弹幕
- 回合历史回放、最强联想词排行榜
- 词库提示 / 语音朗读倒计时
