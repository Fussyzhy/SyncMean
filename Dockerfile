# 同声传意 · 生产镜像（多阶段）
#
#   builder：一次联网装全量依赖 → Vite 构建前端(dist/public) + tsc 编译后端(dist/server)
#            再离线装一份「只有生产依赖」的 node_modules
#   runtime：完全不需要网络，只拷 dist 与那份生产 node_modules；非 root，内置 /health 探活
#
# 技术栈：Node 22 + Express 4 + Socket.IO 4 + TypeScript（后端）
#         前端 Vue 3 + Vite + Sass（构建期，运行期不需要）
# 注意：房间数据全在进程内存，只能跑 1 个副本。
#
# 关于依赖下载源（这就是构建「卡在 yarn install」的根因）：
#   yarn.lock 里每个包的 resolved 都写死了绝对下载地址（本仓库是 registry.npmmirror.com）。
#   Yarn 1 会优先用 lockfile 里的 resolved 下载，`yarn config set registry` 对已锁定的包无效，
#   所以必须按 YARN_REGISTRY 重写 lockfile，换源才真正生效。
#   - 默认用 npmmirror（与 lockfile 一致，国内快）
#   - 构建机在海外/访问镜像慢：docker build --build-arg YARN_REGISTRY=https://registry.npmjs.org .

# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder

WORKDIR /app

ARG YARN_REGISTRY=https://registry.npmmirror.com
# 弱网时单包下载超时（毫秒）。默认 30s 容易在慢链路上反复重试，看起来像卡死。
ARG YARN_NETWORK_TIMEOUT=300000

# 依赖清单先落地，最大化利用层缓存
COPY package.json yarn.lock ./

# 让 lockfile 里的 resolved 域名跟随 YARN_REGISTRY（Yarn 1 不认 registry 配置，只认 resolved）
RUN if [ "$YARN_REGISTRY" != "https://registry.npmmirror.com" ]; then \
      sed -i "s|https://registry.npmmirror.com|$YARN_REGISTRY|g" yarn.lock; \
    fi

# 唯一的联网安装：全量依赖（构建前端需要 vue/vite/sass/tsx 等）
RUN yarn install --frozen-lockfile --non-interactive \
      --network-timeout "$YARN_NETWORK_TIMEOUT"

# 构建所需源码与配置（tools/ 与 .verify/ 已在 .dockerignore 排除，构建不需要）
COPY tsconfig.json tsconfig.server.json tsconfig.app.json vite.config.ts ./
COPY src ./src

# 前端 Vite 构建 + 后端 tsc 编译（输出 dist/public 与 dist/server）
RUN yarn build

# 生产依赖单独装一份：只从上面那份 yarn 缓存离线取，不再联网。
# （express / socket.io 及其 78 个传递依赖；vue/vite/sass/tsx 都不进运行期）
RUN yarn install --frozen-lockfile --production --ignore-scripts --offline --non-interactive \
      --modules-folder /prod-node-modules

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3210

# package.json 必须带上：里面有 "type": "module"，dist/server 是 ESM
COPY package.json ./
# 构建阶段离线装好的生产依赖（纯 JS，无原生二进制）
COPY --from=builder /prod-node-modules ./node_modules
# 编译产物：dist/server/index.js + dist/public/**
COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 3210

# 探活用应用自己的 /health（Alpine 没有 curl，用 node 内置 fetch）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式直接跑 node（不要用 yarn start）：
# 这样 docker stop 的 SIGTERM 会直达 node 进程，server 的 shutdown() 才会执行。
CMD ["node", "dist/server/index.js"]
