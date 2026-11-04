#!/usr/bin/env bash
# 可选：给 2C2G（或更小）的小机器加一块 swap —— 内存兜底，不是日常部署的必需步骤。
#
# 日常部署（dist 入库 + 预构建镜像）构建峰值 ~500MB，2G 机器不加 swap 也能跑；
# 加 swap 的价值是「万一内存抖动/泄漏时不会随机杀 sshd、dockerd 导致失联」。
#
# 用法（root）：
#   sudo bash deploy/enable-swap.sh          # 默认 2048MB
#   sudo bash deploy/enable-swap.sh 4096     # 4G
#
# 会做：创建并启用 swapfile、写 /etc/fstab（开机自动挂载）、vm.swappiness=10。
# 可重复执行（已经启用就跳过创建）。
set -euo pipefail

SIZE_MB="${1:-2048}"
SWAPFILE="${SWAPFILE:-/swapfile}"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root：sudo bash $0 [大小MB]" >&2
  exit 1
fi

case "$SIZE_MB" in
  '' | *[!0-9]*)
    echo "大小必须是整数 MB，收到：$SIZE_MB" >&2
    exit 1
    ;;
esac

echo "== 当前内存 / swap =="
free -m || true

# 用 /proc/swaps 判断（busybox 的 swapon 不一定支持 --show）
is_active_swap() {
  awk -v f="$SWAPFILE" 'NR > 1 && $1 == f { found = 1 } END { exit !found }' /proc/swaps
}

if is_active_swap; then
  echo "== $SWAPFILE 已经是活动 swap，跳过创建 =="
else
  if [ -e "$SWAPFILE" ]; then
    echo "错误：$SWAPFILE 已存在但不是活动 swap，为安全起见不覆盖（请先人工确认再处理）。" >&2
    exit 1
  fi
  avail_mb=$(df -Pm "$(dirname "$SWAPFILE")" | awk 'NR==2{print $4}')
  need_mb=$((SIZE_MB + 1024))
  if [ "${avail_mb:-0}" -lt "$need_mb" ]; then
    echo "错误：$(dirname "$SWAPFILE") 只剩 ${avail_mb}MB，至少需要 ${need_mb}MB（swap 文件 + 余量）。" >&2
    exit 1
  fi

  echo "== 创建 ${SIZE_MB}MB swap：$SWAPFILE =="
  if ! fallocate -l "${SIZE_MB}M" "$SWAPFILE" 2>/dev/null; then
    # btrfs / 部分 overlay 上 fallocate 会失败，退回 dd
    echo "fallocate 不可用，改用 dd（慢一些）..."
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SIZE_MB"
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  swapon "$SWAPFILE"
fi

# 开机自动挂载（fstab 里没有这一行才加）
if ! awk -v f="$SWAPFILE" '$1 == f && $3 == "swap" { found = 1 } END { exit !found }' /etc/fstab; then
  printf '%s none swap sw 0 0\n' "$SWAPFILE" >>/etc/fstab
  echo "已写入 /etc/fstab：$SWAPFILE none swap sw 0 0"
fi

# 小机器上 swap 用积极一点点，但别过度换出（10 = 只在真压力下用）
if [ -d /etc/sysctl.d ]; then
  printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-syncmean-swap.conf
fi
sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true

echo
echo "== 完成 =="
swapon --show 2>/dev/null || cat /proc/swaps || true
free -m || true
echo
echo "日常部署：git pull && docker compose up -d --build"
echo "（docker-compose.yml 默认用 Dockerfile.prebuilt，只装生产依赖 + COPY dist/，见 README §8）"
