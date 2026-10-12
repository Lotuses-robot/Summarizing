# ── 构建阶段：编译前端 + esbuild 打包服务端单文件 ──
# 只在 CI/本地构建镜像时用；服务器只 pull（避开 2C2G 构建内存尖峰，见 docs/11 阶段 2）。
FROM node:22-slim AS build
WORKDIR /app

# 先只拷依赖清单（缓存层：依赖不变则跳过 install）
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# 全量安装（含 devDeps：构建要 vite/esbuild/typescript）——npm ci 按 lockfile 精确复现
RUN npm ci

# 拷源码后构建：前端 vite + 服务端 esbuild 单文件（复用 build-release 的服务端打包逻辑等价物）
COPY . .
RUN npm run build -w @summarizing/web \
 && npx esbuild apps/server/src/index.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile=apps/server/dist/index.mjs --external:better-sqlite3 \
      --banner:js='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' \
 && npx esbuild scripts/admin.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile=apps/server/dist/admin.mjs --external:better-sqlite3 \
      --banner:js='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'

# ── 运行阶段：只带运行需要的东西（无 devDeps / 无源码）──
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行依赖：生产依赖（只有 better-sqlite3 等运行时需要）+ 其原生预编译随包下发
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# --omit=dev：只装生产依赖（better-sqlite3 的 linux-x64 预编译随 npm 包一并安装，无需编译）
RUN npm ci --omit=dev && npm cache clean --force

# 从构建阶段取产物：服务端单文件 + 前端静态
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# data/ 目录（运行时会 bind mount 到宿主机；容器内只作挂载点）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 非 root 运行（安全）：node 镜像自带 uid 1000 的 node 用户
# data 属主由 compose 的 bind mount 决定——宿主机目录需可写（见 docs/11 部署注意）
USER node

EXPOSE 3001
# PORT 环境变量可控（默认 3001）；host 0.0.0.0（容器内必需）
ENV PORT=3001

# 健康检查：未登录面 GET /api/board 应回 401（服务活着即通过——200 也正常）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/board').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"

# 入口：server（前端静态由 @fastify/static 合并同端口，见 index.ts）
CMD ["node", "apps/server/dist/index.mjs"]
