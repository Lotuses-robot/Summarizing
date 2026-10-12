#!/usr/bin/env bash
# 服务器初始化一条龙（批次 2 / docs/13 一）——新机器上以 root/sudo 跑一次。
# 做四件事：装 Docker → 防火墙只开 80/443/SSH → 开 swap → 建 data/ 并设属主（uid 1000）。
# 面向：阿里云 Ubuntu/Debian。
#
# 用法：sudo ./server-init.sh <部署目录>
#   <部署目录> = docker-compose.yml 所在目录（如 ~/summarizing 或 /opt/summarizing）。
#   省略则用当前目录。
#
# ⚠️ 顺序很关键：**先建好目录（含 data/）再 docker compose up**。
#   若 data/ 是 compose up 时才由 Docker 建的，会归 root → 容器内 node(1000) 写不进
#   → 首启 SQLITE_CANTOPEN（2026-10-12 首次部署实测踩坑）。本脚本的 data 属主步可**反复跑**修此问题：
#     sudo ./server-init.sh <部署目录> --data-only
set -euo pipefail

SWAP_GB=2
REPO_DIR="${1:-$PWD}"
DATA_ONLY="${2:-}"

# ── --data-only：只修 data/ 属主（可反复跑；compose up 后若忘了、或目录被重建时用）──
if [ "$DATA_ONLY" = "--data-only" ]; then
  echo "==> 只修 data/ 属主：${REPO_DIR}/data"
  mkdir -p "${REPO_DIR}/data"
  chown -R 1000:1000 "${REPO_DIR}/data"
  echo "✓ 完成。重启应用：cd ${REPO_DIR} && docker compose restart app"
  exit 0
fi

echo "==> 1/4 安装 Docker"
if ! command -v docker >/dev/null 2>&1; then
  # 官方脚本（国内常连不上 get.docker.com → 退回阿里云 apt 源）
  if ! curl -fsSL https://get.docker.com | sh; then
    echo "    官方源不可用，改用阿里云 Docker 源…"
    install -m 0755 -d /etc/apt/keyrings
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  # 当前用户加进 docker 组（之后需重登 SSH 才生效；root 跑则加 root）
  usermod -aG docker "${SUDO_USER:-root}" 2>/dev/null || true
else
  echo "    Docker 已装，跳过"
fi

echo "==> 2/4 防火墙：只开 80/443/SSH"
# 云厂商安全组另需在控制台放行同一组端口（本脚本只管机器内防火墙）
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
  ufw allow OpenSSH || ufw allow 22/tcp || true
  ufw --force enable || true
else
  echo "    （无 ufw；按发行版用 firewalld/iptables 等价放行 80/443 + SSH）"
fi

echo "==> 3/4 swap ${SWAP_GB}G（内存尖峰 OOM 保险，docs/11 阶段 1）"
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024))
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "    swap 已存在，跳过"
fi

echo "==> 4/4 data/ 目录（须 uid 1000 可写——容器内 node 用户）"
mkdir -p "${REPO_DIR}/data"
chown -R 1000:1000 "${REPO_DIR}/data"

echo "✓ 初始化完成（部署目录 ${REPO_DIR}）。"
echo "  下一步：把 docker-compose.yml / Caddyfile / .env 放进该目录，docker compose up -d"
echo "  ⚠️ 若 compose up 时 data/ 才被 Docker 建出（归 root）导致 SQLITE_CANTOPEN，重跑："
echo "     sudo ./server-init.sh ${REPO_DIR} --data-only"
