#!/usr/bin/env sh
# 版本管理（服务器运维机用；**只依赖 docker compose + curl**——面向「宿主机没 node/npm/git、只有 docker」的形态）。
# 不自带任何自动更新：列出可用版本、由你**选一个**装（也可直接给版本号）。它是"手动挑版本装"的工具，不是自动跟新版。
#
# 用法（在放 docker-compose.yml 和 .env 的目录里）：
#   ./update.sh                 # 列出最近版本 + 当前在跑哪个 → 编号选一个装（默认高亮最新）
#   ./update.sh --list          # 只列版本（标出「当前在跑 / 最新」），不动手
#   ./update.sh --status        # 只看当前在跑什么版本 + 容器状态
#   ./update.sh v0.3.1          # 直接装指定版本（已知版本号时最快；离线也能用）
#   ./update.sh --check         # 同 --list（兼容旧用法）
#
# 前提（自检，不满足就报人话并退出）：
#   1. 当前目录有 docker-compose.yml 与 .env，且 .env 里有 APP_IMAGE=<镜像地址>:<版本>
#      （「CI 出镜像 → 服务器只 pull」的生产形态；本地 build 形态没有 APP_IMAGE，本脚本不适用）。
#   2. 已 docker login 过镜像仓库（私有仓库必须；未登录时拉取会失败，脚本会提示）。
# 回滚：见 docs/13 三·5（改回版本号 + 用升级前备份还原）。
#
# ⚠️ 只换 .env 里 APP_IMAGE 最后一个冒号后的版本号——保留仓库地址与命名空间、保留其余行与注释。
set -eu

REPO="${UPDATE_REPO:-Lotuses-robot/Summarizing}"   # GitHub 仓库（列版本用；可用环境变量覆盖）
COMPOSE="docker compose"                            # 老版独立二进制改 docker-compose
LIST_COUNT="${UPDATE_LIST_COUNT:-10}"               # 列多少个版本

info() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 环境自检 ──
[ -f docker-compose.yml ] || die "当前目录没有 docker-compose.yml——请 cd 到部署目录再跑"
[ -f .env ] || die "当前目录没有 .env——本脚本按「ACR 形态」更新，需要 .env 里的 APP_IMAGE"
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用"
has_curl() { command -v curl >/dev/null 2>&1; }

# ── 读 .env 的 APP_IMAGE（剥引号、剥行内注释）→ BASE 与当前版本 ──
read_app_image() {
  grep -E '^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=' .env | head -1 \
    | sed -E 's/^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/^["'"'"']//; s/["'"'"']$//'
}
app_image=$(read_app_image)
[ -n "$app_image" ] || die ".env 里没有 APP_IMAGE（本地 build 形态？本脚本只用于「拉镜像」形态）"
case "$app_image" in
  *:*) img_base="${app_image%:*}"; img_tag="${app_image##*:}" ;;
  *)   die ".env 的 APP_IMAGE 没有版本号（形如 ...:vX.Y.Z）：$app_image" ;;
esac
case "$img_tag" in */*) die ".env 的 APP_IMAGE 版本号异常（疑似把仓库端口号当版本）：$app_image" ;; esac

# ── 取 GitHub 版本列表（tag_name，新→旧，最多 LIST_COUNT 个）──
fetch_tags() {
  has_curl || return 1
  curl -fsSL --max-time 20 -H "accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases?per_page=${LIST_COUNT}" 2>/dev/null \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"([^"]*)"$/\1/'
}

# ── 显示当前状态 ──
show_status() {
  info "当前在跑（.env 声明）：$app_image"
  printf '  容器：\n'
  $COMPOSE ps 2>/dev/null | sed 's/^/    /' || warn "  （docker compose ps 取不到）"
}

# ── 列版本表（标出当前/最新），顺带把最新闻到 TAGS 变量 ──
print_and_load_tags() {
  TAGS=$(fetch_tags) || return 1
  [ -n "$TAGS" ] || return 1
  newest=$(printf '%s\n' "$TAGS" | head -1)
  i=0
  printf '\n  可用版本（新 → 旧）：\n'
  printf '%s\n' "$TAGS" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    i=$((i + 1))
    mark=""
    [ "$t" = "$img_tag" ] && mark="  ← 当前在跑"
    [ "$t" = "$newest" ] && [ "$t" != "$img_tag" ] && mark="  ← 最新"
    printf '    %2d) %s%s\n' "$i" "$t" "$mark"
  done
  printf '\n  当前在跑：%s\n' "$img_tag"
}

# ── 执行升级到 $1（目标版本号）──
do_upgrade() {
  target="$1"
  # 校验目标版本格式（v 开头、无空格）
  case "$target" in
    v*) ;;
    *) die "版本号应以 v 开头（如 v0.3.1）：$target" ;;
  esac
  if [ "$target" = "$img_tag" ]; then
    ok "当前已是在跑的版本（$target），无需更新。"
    exit 0
  fi
  new_image="${img_base}:${target}"

  # 升级前备份（容器内 admin；在线热备）
  info "备份数据…（容器内 admin backup）"
  $COMPOSE exec -T app node apps/server/dist/admin.mjs backup \
    || die "备份失败——已中止，未做任何改动。先查：$COMPOSE logs --tail 50 app"

  # 改 .env：只换版本号，保留其余行与注释（含 export 前缀、行尾）
  info ".env：APP_IMAGE 版本号 $img_tag → $target"
  cp .env ".env.bak.$$"            # 退路（改坏可 cp 回来）
  awk -v img="$new_image" '
    /^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=/ && !done {
      line=$0
      eol = (line ~ /\r$/) ? "\r" : ""
      sub(/\r$/, "", line)
      sub(/^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=[[:space:]]*.*$/, "APP_IMAGE=" img, line)
      print line eol; done=1; next
    }
    { print }
  ' .env > .env.new && mv .env.new .env
  grep -q "APP_IMAGE=${new_image}" .env || die ".env 改写失败——已备份到 .env.bak.$$，请手动改 APP_IMAGE=${new_image}"

  # 拉新镜像 + 重启（只拉不 build）
  info "拉新镜像…"
  $COMPOSE pull app || die "拉取失败——常见原因：镜像还没推上仓库（CI 未跑完）或未 docker login。.env 已改为 $new_image，可改回或重试。"
  info "重启…"
  $COMPOSE up -d --no-build || die "重启失败——看 $COMPOSE logs --tail 100 app"

  # 健康检查（等服务回 401；未登录面）
  info "健康检查…"
  code=x; i=0
  while [ "$i" -lt 15 ]; do
    code=$($COMPOSE exec -T app node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||3001)+"/api/board").then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1 && echo 401 || echo x)
    [ "$code" = "401" ] && break
    i=$((i + 1)); sleep 3
  done
  if [ "$code" != "401" ]; then
    warn "30s 内健康检查未通过（/api/board 未回 401）。"
    warn "下一步：$COMPOSE logs --tail 100 app 看 [schema]/[space] 报错；回滚见 docs/13 三·5。"
    die "更新未确认成功。历史 .env 备份：.env.bak.$$"
  fi
  bad=$($COMPOSE logs --tail 500 app 2>&1 | grep -E '\[schema\]|\[space\].*装配失败' || true)
  if [ -n "$bad" ]; then
    warn "日志里有可疑报错行："; printf '%s\n' "$bad" | tail -5
    die "更新未确认成功（见上）。回滚见 docs/13 三·5；历史 .env 备份：.env.bak.$$"
  fi
  ok "✓ 更新完成：$img_tag → $target"
  info "本次 .env 备份：.env.bak.$$（确认无误后可删）"
}

# ── 参数分发 ──
arg="${1:-}"
case "$arg" in
  --status) show_status; exit 0 ;;
  --list | --check)
    if print_and_load_tags; then exit 0; else
      warn "取不到 GitHub 版本列表（无 curl / 网络 / 限流）。"
      show_status
      exit 1
    fi
    ;;
  "") ;;                      # 交互选择
  -*) die "未知参数：$arg（用法：./update.sh [vX.Y.Z|--list|--status]）" ;;
  *) do_upgrade "$arg"; exit 0 ;;   # 直接指定版本
esac

# ── 交互：列版本 → 编号选 → 装 ──
[ -t 0 ] || die "非交互终端：请直接给版本号，如 ./update.sh v0.3.1（或用 --list 查看）"
if ! print_and_load_tags; then
  warn "取不到 GitHub 版本列表（无 curl / 网络 / 限流）——请手动指定版本：./update.sh vX.Y.Z"
  exit 1
fi
printf '\n选择要安装的版本编号（回车取消；或直接输 vX.Y.Z）：'
read -r choice || choice=""
case "$choice" in
  "") ok "已取消。"; exit 0 ;;
  v*) target="$choice" ;;
  *[!0-9]* | "") die "无效选择：$choice" ;;
  *) target=$(printf '%s\n' "$TAGS" | sed -n "${choice}p") ;;
esac
[ -n "$target" ] || die "无效编号：$choice"
do_upgrade "$target"
