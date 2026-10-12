#!/usr/bin/env bash
# 服务器初始化一条龙（批次 2 / docs/13 一）——新机器上以 root/sudo 跑一次。
# 做四件事：装 Docker → 防火墙只开 80/443/SSH → 开 swap → 建 data/ 并设属主。
# 面向：阿里云轻量 Ubuntu/Debian。其它发行版见注释里的等价命令。
#
# ⚠️ 跑之前先看一遍、按需改端口/swap 大小（2G 内存机器建议 2G swap）。
set -euo pipefail

SWAP_GB=2
REPO_DIR="/opt/summarizing"   # 部署目录（docker-compose.yml 所在）；按需改

echo "==> 1/4 安装 Docker（官方脚本）"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
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
# 注：若 data/ 用 bind mount，宿主目录属主即容器内视角——属主错 → 首启 SQLITE_CANTOPEN（docs/13 一）

echo "✓ 初始化完成。下一步：把代码放到 ${REPO_DIR}，cp .env.example .env，docker compose up -d --build"
