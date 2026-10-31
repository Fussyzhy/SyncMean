# 同声传意 · 生产镜像
# 纯 Node + Express + Socket.IO，无构建步骤、无数据库、房间数据在内存里。
FROM node:22-alpine

WORKDIR /app

# 端口由应用自己从 PORT 读取（server.js: process.env.PORT || 3210）
ENV NODE_ENV=production \
    PORT=3210

# 只装生产依赖（socket.io-client 是 devDependencies，仅测试用，不进镜像）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 运行时真正需要的文件（tools/、.verify/ 已由 .dockerignore 排除）
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# 用镜像自带的非 root 用户运行
USER node

EXPOSE 3210

# 探活用应用自己的 /health（Alpine 镜像没有 curl，用 node 内置 fetch，不额外装包）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 exec 形式直接跑 node（不要用 npm start）：
# 这样 docker stop 发的 SIGTERM 会直达 node 进程，server.js 里的 shutdown() 才会正常执行。
CMD ["node", "server.js"]
