#!/usr/bin/env bash
# 可选方案：服务器只拉取别处构建好的镜像并重启（配合 CI / 镜像仓库，见 README §8）。
#
# 日常默认部署方式是「dist 入库 + docker compose up -d --build」，不需要本脚本。
#
# 用法：
#   bash deploy/deploy-pull.sh
#
# 前置：项目根目录 .env 里有 SYNCMEAN_IMAGE=...（ADMIN_KEY 也在这里配）。
# 依赖：docker compose v2、curl。
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "找不到 $COMPOSE_FILE" >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "警告：没有 .env。请至少写入 SYNCMEAN_IMAGE=...（和 ADMIN_KEY=...）" >&2
fi

echo "== 1/3 拉取镜像 =="
# 拉失败不直接退出：用 docker save / docker load 传过来的镜像本来就没有远端可拉，
# 只要本地有同名镜像，up 就能起来；本地也没有时 up 会报清楚的错。
if ! docker compose -f "$COMPOSE_FILE" pull; then
  echo "⚠️  拉取失败，改为使用本地已有镜像（若本地也没有会启动失败，请检查 SYNCMEAN_IMAGE）" >&2
fi

echo "== 2/3 重建容器 =="
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo "== 3/3 清理旧镜像 + 探活 =="
docker image prune -f >/dev/null 2>&1 || true

if ! command -v curl >/dev/null 2>&1; then
  echo "本机没有 curl，跳过 /health 探活；用 docker compose ps 看状态："
  docker compose -f "$COMPOSE_FILE" ps || true
  exit 0
fi

for _ in $(seq 1 20); do
  if body=$(curl -fsS --max-time 2 http://127.0.0.1:3210/health 2>/dev/null); then
    echo "健康检查通过：$body"
    exit 0
  fi
  sleep 1
done
echo "容器已启动，但 /health 20 秒内没通，看看日志：" >&2
echo "  docker compose -f $COMPOSE_FILE logs --tail=100" >&2
exit 1
