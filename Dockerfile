# ── 构建阶段：编译前端 + esbuild 打包服务端单文件 ──
# 只在 CI/本地构建镜像时用；服务器只 pull（避开 2C2G 构建内存尖峰，见 docs/11 阶段 2）。
FROM node:22-slim AS build
WORKDIR /app

# 先只拷依赖清单（缓存层：依赖不变则跳过 install）
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# 全量安装（含 devDeps：构建要 vite/esbuild/typescript）——npm ci 按 lockfile 精确复现。
# --ignore-scripts 必需：否则 better-sqlite3 触发 node-gyp 源码编译（slim 镜像无 python/make/g++ → 构建失败）。
# 依赖均自带预编译二进制（better-sqlite3 prebuilds、esbuild 平台包），禁脚本不影响可用性（容器内实测通过）。
RUN npm ci --ignore-scripts

# 拷源码后构建：前端 vite + 服务端 esbuild 单文件（打包配方复用 scripts/build-server.mjs，与便携包同一出处）
COPY . .
RUN npm run build -w @summarizing/web \
 && node scripts/build-server.mjs .

# ── 运行阶段：只带运行需要的东西（无 devDeps / 无源码 / 无前端源码依赖）──
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行时依赖：只有 better-sqlite3（服务端 esbuild bundle 只外挂它）——从构建阶段取精简副本
# （package.json + lib + 本平台预编译，≈2MB）。其余生产依赖/web 工作区依赖（react 等）运行时都加载不到，
# 整棵 npm 生产树（含 42MB react）不进镜像（便携包同款做法，见 build-release.mjs）。
COPY --from=build /app/node_modules/better-sqlite3/package.json ./node_modules/better-sqlite3/
COPY --from=build /app/node_modules/better-sqlite3/lib ./node_modules/better-sqlite3/lib
COPY --from=build /app/node_modules/better-sqlite3/prebuilds/linux-x64.node ./node_modules/better-sqlite3/prebuilds/

# 从构建阶段取产物：服务端单文件 + 前端静态
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# data/ 目录（运行时会 bind mount 到宿主机；容器内只作挂载点）。
# chown 给 node：命名卷场景属主从镜像初始化；bind mount 场景宿主机目录需可写（见 docs/11 部署注意）
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# 非 root 运行（安全）：node 镜像自带 uid 1000 的 node 用户
USER node

# PORT 由 compose 设（默认 3001 见 index.ts）；EXPOSE 仅文档化
EXPOSE 3001

# 健康检查：未登录面 GET /api/board 应回 401（只认 401——该面受保护，其它都是异常）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/board').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"

# 入口：server（前端静态由 @fastify/static 合并同端口，见 index.ts）
CMD ["node", "apps/server/dist/index.mjs"]
