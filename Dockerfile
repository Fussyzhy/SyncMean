# 同声传意 · 生产镜像（多阶段）
#
#   builder：装全量依赖 → Vite 构建前端(dist/public) + tsc 编译后端(dist/server)
#   runtime：只装生产依赖，跑编译产物；非 root，内置 /health 探活
#
# 技术栈：Node 22 + Express 4 + Socket.IO 4 + TypeScript（后端）
#         前端 Vue 3 + Vite + Sass（构建期，运行期不需要）
# 注意：房间数据全在进程内存，只能跑 1 个副本。

# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder

WORKDIR /app

# 国内网络慢时可换源：docker build --build-arg YARN_REGISTRY=https://registry.npmmirror.com
ARG YARN_REGISTRY=https://registry.npmjs.org
RUN yarn config set registry "$YARN_REGISTRY"

# 依赖清单先落地，最大化利用层缓存
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive

# 构建所需源码与配置（tools/ 与 .verify/ 已在 .dockerignore 排除，构建不需要）
COPY tsconfig.json tsconfig.server.json tsconfig.app.json vite.config.ts ./
COPY src ./src

# 前端 Vite 构建 + 后端 tsc 编译（输出 dist/public 与 dist/server）
RUN yarn build

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3210

ARG YARN_REGISTRY=https://registry.npmjs.org
RUN yarn config set registry "$YARN_REGISTRY"

# 只装生产依赖（express / socket.io；vue、vite、sass、tsx 都只在构建期需要）
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production --ignore-scripts --non-interactive \
    && yarn cache clean

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
