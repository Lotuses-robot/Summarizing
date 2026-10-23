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
# nodejieba（D-127 切词）：有 linux-x64 预编译产物、但安装脚本就是「下载预编译」那一步——
# --ignore-scripts 把它一并跳过了，故单独补跑（走 node-pre-gyp 下载，不编译；slim 镜像无工具链也能成）。
RUN npm rebuild nodejieba --foreground-scripts

# 拷源码后构建：前端 vite + 服务端 esbuild 单文件（打包配方复用 scripts/build-server.mjs，与便携包同一出处）
COPY . .
RUN npm run build -w @summarizing/web \
 && node scripts/build-server.mjs .

# ── 运行阶段：只带运行需要的东西（无 devDeps / 无源码 / 无前端源码依赖）──
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行时依赖：原生模块（服务端 esbuild bundle 只外挂它们）——从构建阶段取精简副本。
# better-sqlite3：package.json + lib + 本平台预编译（≈2MB）
# sharp（009 图片压缩）：package.json + dist（JS 全在 dist）+ linux-x64 预编译与 libvips
#   + 三个运行时小依赖（semver / detect-libc / @img/colour）
# 其余生产依赖/web 工作区依赖（react 等）运行时都加载不到，整棵 npm 生产树不进镜像（便携包同款做法）。
COPY --from=build /app/node_modules/better-sqlite3/package.json ./node_modules/better-sqlite3/
COPY --from=build /app/node_modules/better-sqlite3/lib ./node_modules/better-sqlite3/lib
COPY --from=build /app/node_modules/better-sqlite3/prebuilds/linux-x64.node ./node_modules/better-sqlite3/prebuilds/
COPY --from=build /app/node_modules/sharp/package.json ./node_modules/sharp/
COPY --from=build /app/node_modules/sharp/dist ./node_modules/sharp/dist
COPY --from=build /app/node_modules/@img/sharp-linux-x64 ./node_modules/@img/sharp-linux-x64
COPY --from=build /app/node_modules/@img/sharp-libvips-linux-x64 ./node_modules/@img/sharp-libvips-linux-x64
COPY --from=build /app/node_modules/semver ./node_modules/semver
COPY --from=build /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build /app/node_modules/@img/colour ./node_modules/@img/colour
# nodejieba（D-127 切词）：index.js + 类型 + linux-x64 预编译 .node + 词典。
# 词典必须齐（5 个文件）：nodejieba 首次切词按默认路径 load 全部词典，缺任一个会 FATAL 退进程
# （实测：不是可捕获异常）。pos_dict/ 只服务词性标注，本项不用。
COPY --from=build /app/node_modules/nodejieba/package.json ./node_modules/nodejieba/
COPY --from=build /app/node_modules/nodejieba/index.js ./node_modules/nodejieba/
COPY --from=build /app/node_modules/nodejieba/types ./node_modules/nodejieba/types
COPY --from=build /app/node_modules/nodejieba/build/Release/nodejieba.node ./node_modules/nodejieba/build/Release/
COPY --from=build /app/node_modules/nodejieba/submodules/cppjieba/dict/jieba.dict.utf8 ./node_modules/nodejieba/submodules/cppjieba/dict/
COPY --from=build /app/node_modules/nodejieba/submodules/cppjieba/dict/hmm_model.utf8 ./node_modules/nodejieba/submodules/cppjieba/dict/
COPY --from=build /app/node_modules/nodejieba/submodules/cppjieba/dict/user.dict.utf8 ./node_modules/nodejieba/submodules/cppjieba/dict/
COPY --from=build /app/node_modules/nodejieba/submodules/cppjieba/dict/idf.utf8 ./node_modules/nodejieba/submodules/cppjieba/dict/
COPY --from=build /app/node_modules/nodejieba/submodules/cppjieba/dict/stop_words.utf8 ./node_modules/nodejieba/submodules/cppjieba/dict/

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
