#!/usr/bin/env bash
# 可选方案：在「内存充足」的机器或 CI 上从源码完整构建镜像并推送。
#
# 日常 2C2G 部署**不需要**它（默认方式是 dist 入库 + Dockerfile.prebuilt，见 README §8）；
# 这个脚本用于「不想让 git 里带 dist 产物 / 想用镜像仓库分发」的情况。
#
# 用法：
#   IMAGE=ghcr.io/fussyzhy/syncmean:latest bash deploy/build-push.sh
#   IMAGE=registry.cn-hangzhou.aliyuncs.com/你的命名空间/syncmean:v1.0.0 bash deploy/build-push.sh
#
# 前置：先 docker login 到对应 registry（GHCR 用带 write:packages 的 PAT）。
# 构建机内存大，NODE_BUILD_HEAP 默认放开到 2048，构建更快也不怕。
# PLATFORM 默认 linux/amd64（2C2G 云服务器基本是 x86_64）；ARM 机器改成 linux/arm64。
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:?请设置 IMAGE，例如 IMAGE=ghcr.io/fussyzhy/syncmean:latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
HEAP="${NODE_BUILD_HEAP:-2048}"
REGISTRY_SRC="${YARN_REGISTRY:-https://registry.npmmirror.com}"

# 显式指定 Dockerfile（从源码完整构建），避免以后 compose 默认换了文件时行为跟着变
if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform "$PLATFORM" \
    --file Dockerfile \
    --build-arg "NODE_BUILD_HEAP=$HEAP" \
    --build-arg "YARN_REGISTRY=$REGISTRY_SRC" \
    -t "$IMAGE" \
    --push \
    .
else
  # 老版本 Docker 没有 buildx：只能在本机架构上构建，再 push
  echo "未检测到 docker buildx，改用 docker build + docker push（只支持本机架构）"
  docker build --file Dockerfile \
    --build-arg "NODE_BUILD_HEAP=$HEAP" \
    --build-arg "YARN_REGISTRY=$REGISTRY_SRC" \
    -t "$IMAGE" .
  docker push "$IMAGE"
fi

echo
echo "已推送：$IMAGE"
echo "服务器上这样部署："
echo "  1) 项目根目录 .env 里写 SYNCMEAN_IMAGE=$IMAGE"
echo "  2) bash deploy/deploy-pull.sh"
