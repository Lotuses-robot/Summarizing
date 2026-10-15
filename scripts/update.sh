#!/usr/bin/env sh
# 一键更新（服务器运维机用；**只依赖 docker compose + curl**——面向「宿主机没 node/npm、操作靠 docker」的形态）。
#
# 做什么：查 GitHub 最新版 → 比对当前在跑版本 → 改 .env 里的 APP_IMAGE 版本号 → 拉新镜像 → 重启 → 健康检查。
# 用法（在放 docker-compose.yml 和 .env 的目录里）：
#   ./update.sh              # 正常更新（有新版才动手）
#   ./update.sh v0.3.0       # 手动指定目标版本（离线/查不到 GitHub 时用）
#   ./update.sh --check      # 只看有没有新版，不动任何东西
#
# 前提（本脚本会自检，不满足就报人话并退出）：
#   1. 当前目录有 docker-compose.yml 与 .env，且 .env 里有 APP_IMAGE=<镜像地址>:<版本>
#      （这是「CI 出镜像 → 服务器只 pull」的生产形态；本地 build 形态没有 APP_IMAGE，本脚本不适用）。
#   2. 已 docker login 过镜像仓库（私有仓库必须；未登录时拉取会失败，脚本会提示）。
# 回滚：见 docs/13 三·5（改回 .env 的版本号 + 用升级前备份还原）。
#
# ⚠️ 不跟随 .env 里 APP_IMAGE 的整串改写——只换最后一个冒号后的版本号，保留仓库地址与命名空间。
set -eu

REPO="${UPDATE_REPO:-Lotuses-robot/Summarizing}"   # GitHub 仓库（查最新版用；可用环境变量覆盖）
COMPOSE="docker compose"                            # 若你的是老版独立二进制，改成 docker-compose

# ── 小工具 ──
info() { printf '\033[36m%s\033[0m\n' "$*"; }        # 青色：进度
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }        # 绿色：成功
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }    # 黄色：警告
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }   # 红色：失败

# ── 0. 环境自检 ──
[ -f docker-compose.yml ] || die "当前目录没有 docker-compose.yml——请 cd 到部署目录再跑"
[ -f .env ] || die "当前目录没有 .env——本脚本按「ACR 形态」更新，需要 .env 里的 APP_IMAGE"
command -v docker >/dev/null 2>&1 || die "找不到 docker 命令"
docker compose version >/dev/null 2>&1 || die "docker compose 不可用（本脚本要用 docker compose）"
command -v curl >/dev/null 2>&1 || warn "没找到 curl——无法自动查最新版，请用「./update.sh vX.Y.Z」手动指定版本"

# 从 .env 取 APP_IMAGE（剥引号、剥行内注释，与 compose 读法尽量一致）
app_image=$(grep -E '^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=' .env | head -1 \
  | sed -E 's/^[[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/^["'"'"']//; s/["'"'"']$//')
[ -n "$app_image" ] || die ".env 里没有 APP_IMAGE（本地 build 形态？本脚本只用于「拉镜像」形态）"

# 取镜像地址的「仓库部分」与「当前版本」：最后一个冒号后、且不含 / 的才算版本号
case "$app_image" in
  *:*) img_base="${app_image%:*}"; img_tag="${app_image##*:}" ;;
  *)   die ".env 的 APP_IMAGE 没有版本号（形如 ...:vX.Y.Z）：$app_image" ;;
esac
case "$img_tag" in */*) die ".env 的 APP_IMAGE 版本号异常（疑似把仓库端口号当版本）：$app_image" ;; esac
info "当前：$app_image"

# ── 1. 定目标版本：命令行参数 > GitHub 最新 release ──
target="${1:-}"
case "$target" in
  --check) CHECK_ONLY=1; target="" ;;
  "") CHECK_ONLY=0 ;;
  -*) die "未知参数：$target（用法：./update.sh [vX.Y.Z|--check]）" ;;
  *) CHECK_ONLY=0 ;;
esac
if [ -z "$target" ]; then
  command -v curl >/dev/null 2>&1 || die "需要 curl 才能自动查最新版；或改用 ./update.sh vX.Y.Z"
  info "查 GitHub 最新版…"
  json=$(curl -fsSL --max-time 20 -H "accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null) \
    || die "查不到 GitHub 最新版（网络/限流？）——可用 ./update.sh vX.Y.Z 手动指定"
  target=$(printf '%s' "$json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
    | sed -E 's/.*"([^"]*)"$/\1/')
  [ -n "$target" ] || die "GitHub 返回里没有 tag_name——请用 ./update.sh vX.Y.Z 手动指定"
fi
info "目标：$target"

# ── 2. 比对：已最新则不折腾 ──
if [ "$target" = "$img_tag" ]; then
  ok "已是最新（$target），无需更新。"
  exit 0
fi
if [ -n "${CHECK_ONLY:-}" ]; then
  warn "有新版本：$img_tag → $target（--check 模式，未做任何改动）"
  exit 0
fi

# 简单防降级（只认 v主.次.修 形状；预发/异形不判，交给人）
ver_num() { printf '%s' "${1#v}" | awk -F. '{printf "%d%03d%03d", $1, $2, $3}' 2>/dev/null || true; }
c=$(ver_num "$img_tag"); t=$(ver_num "$target")
if [ -n "$c" ] && [ -n "$t" ] && [ "$t" -lt "$c" ] 2>/dev/null; then
  die "目标 $target 比当前 $img_tag 旧——拒绝降级。确实要回退见 docs/13 三·5。"
fi

# ── 3. 升级前备份（在线热备，走容器内 admin；这一步正好用 exec）──
info "备份数据…（容器内 admin backup）"
$COMPOSE exec -T app node apps/server/dist/admin.mjs backup \
  || die "备份失败——已中止，未做任何改动。先查：$COMPOSE logs --tail 50 app"

# ── 4. 改 .env：只换版本号，保留仓库地址与其余内容 ──
new_image="${img_base}:${target}"
info ".env：APP_IMAGE 版本号 $img_tag → $target"
cp .env .env.bak.$$            # 留个退路（改坏可 cp 回来）
sed -i.tmp -E "s|^([[:space:]]*(export[[:space:]]+)?APP_IMAGE[[:space:]]*=[[:space:]]*).*$|\1${new_image}|" .env
rm -f .env.tmp
grep -q "APP_IMAGE=${new_image}\$" .env || die ".env 改写失败——已备份到 .env.bak.$$，请手动改 APP_IMAGE=${new_image}"

# ── 5. 拉新镜像 + 重启（只拉不 build）──
info "拉新镜像…"
$COMPOSE pull app || die "拉取失败——常见原因：镜像还没推上仓库（CI 未跑完）或未 docker login。.env 已改为 $new_image，可改回或重试。"
info "重启…"
$COMPOSE up -d --no-build || die "重启失败——看 $COMPOSE logs --tail 100 app"

# ── 6. 健康检查（等服务回 401；未登录面）──
info "健康检查…"
i=0
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
# 日志里挑致命行（[schema] 或 [space] 装配失败）——正常启动信息不含这两样
bad=$($COMPOSE logs --tail 500 app 2>&1 | grep -E '\[schema\]|\[space\].*装配失败' || true)
if [ -n "$bad" ]; then
  warn "日志里有可疑报错行："; printf '%s\n' "$bad" | tail -5
  die "更新未确认成功（见上）。回滚见 docs/13 三·5；历史 .env 备份：.env.bak.$$"
fi

ok "✓ 更新完成：$img_tag → $target"
info "本次 .env 备份：.env.bak.$$（确认无误后可删）"
info "复核：$COMPOSE ps；备份列表 ls -1 data/backups/"
