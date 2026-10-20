# Tasks: 图片持久化（前台上传 + 信源图片缓存）

**Input**: Design documents from `/specs/009-image-persistence/`

**Prerequisites**: plan.md (required), spec.md (required)

**Tests**: 本特性要求测试（SC-005：`npm run check` 全绿、真实入口断言用户所见）。

> **规模与切法**：本特性横跨存储/路由/进站/agent0/前端，按 **4 个 commit 回滚点**切开。
> 每刀结束时 `npm run check` + `check:dead` 全绿，且能独立演示一件事——不允许半刀落地。
> 同一刀内任务按「测试先写并确认 FAIL → 实现 → 勾选」推进。

**Organization**: 刀 1 后端底座 → 刀 2 前台上传与渲染 → 刀 3 信源进站缓存 → 刀 4 引用判定与 TTL 联动 → 收尾。

## Format: `[ID] [P?] [Slice] Description`

- **[P]**: 可并行（不同文件、无依赖）
- 所有路径相对仓库根

---

## Phase 0: 脏形态枚举（先于实现，一次修全）

### 上传与校验

- [ ] T001 空 body / 零字节 / 截断图片（解码失败）/ content-type 与魔数不一致 / SVG / HEIC / 多帧图超限
- [ ] T002 边界：恰好 2 MiB、2 MiB+1、恰好 20 MiB、20 MiB+1、50MP、1×1 像素、EXIF 方向、**压到最低档仍 ≥2 MiB**
- [ ] T003 重复内容（同 sha256 两次上传）/ 两个不同 URL 指向同一图片
- [ ] T004 未登录 / 他人账户 / 不存在 id / 非 hex id / 超长 id / 路径穿越字符 / 文件缺失但行在

### 占位解析

- [ ] T005 `[图片]`（无 URL）/ 相对 URL / 带本站域名的绝对 URL / 同文重复 URL / 超长 URL

### 留存与清理

- [ ] T006 size=0 / size=2 MiB；读过未引用（且原 TTL <3 天 → **不延长**）/ 已引用（**引用 +90 天，多次引用取最后一次**）/ 晚到引用 / 更新时行已删
- [ ] T007 `expiresAt` 恰等于 now / 未来；文件在行不在 / 行在文件不在

---

## 刀 1：后端底座（存储 + 上传/读取接口 + agent0 本地优先）🎯

**Goal**: 通过 `POST /api/media` 上传 → 落盘 + 落行 → `GET /api/media/:id` 读回；agent0 的 `fetch_image` 能解析本地媒体（零网络）；清理器按 TTL 回收。前端尚未接线。

**Independent Test**: curl 上传一张图 → 返回 id → GET 200 且字节一致；上传 >2 MiB 图 → 存储 ≤1.9 MiB；手工把 expiresAt 改成过去 → 清理器运行后文件与行消失且 stderr 留痕。

### Tests（先写并确认 FAIL）

- [ ] T101 [P] [S1] `apps/server/src/test/media.test.ts`：TTL 纯函数（0 / 100 KiB / 1 MiB / 2 MiB → 30/28.9/18.5/7 天；clamp 边界）
- [ ] T102 [P] [S1] `apps/server/src/test/media.test.ts`：`extractImageUrls` / `mediaIdFromUrl` / `textCitesMedia` 的脏形态（T005）
- [ ] T103 [P] [S1] `apps/server/src/test/media.test.ts`：上传校验矩阵（T001/T002：SVG、伪装 MIME、截断、超限）
- [ ] T104 [P] [S1] `apps/server/src/test/media.test.ts`：压缩（大 JPEG → ≤1.9 MiB；**多帧图 >2 MiB → 压缩后 ≤1.9 MiB 且提示动画被压缩**；HEIC 拒收；**最低档仍 ≥2 MiB 拒收**）
- [ ] T105 [P] [S1] `apps/server/src/test/media.test.ts`：读取隔离（未登录 401 / 他人账户 404 / 坏 id 404 / 文件缺失 404）
- [ ] T106 [P] [S1] `apps/server/src/test/media.test.ts`：清理器（过期删文件+行、未过期不动、文件缺失不炸）

### 实现

- [ ] T110 [S1] `apps/server/package.json` 加 `sharp`；`scripts/build-server.mjs` external 加 `"sharp"`；`Dockerfile` runtime 与 `scripts/build-release.mjs` 拷贝 sharp + 平台包 + 三个小依赖（`semver` / `detect-libc` / `@img/colour`）
- [ ] T111 [S1] `packages/shared/src/index.ts`：`MediaRefSchema` / `MediaMapSchema` / `MediaUploadResponseSchema`（含 `animationCompressed: boolean`——动图被降帧/转单帧时 true，前端据此提示）；`GetItemResultSchema` 增 `media`
- [ ] T112 [S1] `apps/server/src/storage/schema.ts`：`media` 表（id/mime/sizeBytes/createdAt/expiresAt/originUrl + 两个索引）
- [ ] T113 [S1] `apps/server/src/storage/db.ts`：ensureSchema 建表 DDL；`migrate.ts` `SCHEMA_VERSION` **3 → 4**（010 已占 3）
- [ ] T114 [S1] `apps/server/src/storage/repo.ts`：`insertMedia` / `getMedia` / `getMediaByOriginUrl` / `updateMediaExpiry` / `listExpiredMedia` / `deleteMediaRow`（幂等插入：同 sha256 重复上传直接复用）
- [ ] T115 [S1] 新 `apps/server/src/shared/imageBytes.ts`：`ALLOWED_IMAGE_MIME` / `matchesMagic` / `sniffImageMime` / `mediaExt`（从 `agent0/fetchImage.ts` 抽出，原处改 import——单一出处）
- [ ] T116 [S1] 新 `apps/server/src/shared/mediaTtl.ts`：`MEDIA_COMPRESS_THRESHOLD` / `MEDIA_TARGET_BYTES` / `MEDIA_MAX_INPUT_BYTES` / `MEDIA_MAX_PIXELS` / `CITED_TTL_DAYS = 90` / `baseMediaTtlMs` / `addDaysWallClock` / `initialMediaExpiry` / `uncitedMediaExpiry` / `citedMediaExpiry`
- [ ] T117 [S1] 新 `apps/server/src/shared/mediaPlaceholders.ts`：`extractImageUrls` / `mediaIdFromUrl` / `textCitesMedia`
- [ ] T118 [S1] 新 `apps/server/src/application/media.ts`：`storeImageBytes(db, mediaDir, bytes, { originUrl })`——校验 → 超限判定 → sharp 压缩（静图：质量阶梯 85→75→65→55，再降采样 2560→1920→1280，PNG 走调色板；**多帧图：先降帧率/丢帧，仍超则按静图档继续压，返回 `animationCompressed=true`**）→ **压到最低档仍 ≥2 MiB 则拒收** → sha256 → 落盘 → 落行（重复内容复用已有行，`expiresAt` 取较晚者）；失败抛人话错误
- [ ] T119 [S1] `application/media.ts`：`sweepExpiredMedia(db, mediaDir)`——删文件+行，stderr 一次汇总（张数/字节）；文件缺失只删行并留痕
- [ ] T120 [S1] 新 `apps/server/src/routes/media.ts`：`POST /api/media`（认证；raw body 解析器只在该路由挂 `image/*`；`bodyLimit` 20 MiB；返回 `MediaUploadResponse`）
- [ ] T121 [S1] `routes/media.ts`：`GET /api/media/:id`（认证 + 本账户库命中 + 文件缺失 404；`Content-Type`、`Cache-Control: private, max-age=31536000, immutable`、`X-Content-Type-Options: nosniff`）
- [ ] T122 [S1] `apps/server/src/spaces.ts`：`Space` 增 `mediaDir`（`dataRoot/media/<uid>`，构造期 mkdir）；`assembleSpace` 装配
- [ ] T123 [S1] `apps/server/src/app.ts`：受保护作用域注册 media 路由
- [ ] T124 [S1] `apps/server/src/agent0/tools.ts` + `fetchImage.ts`：`fetchImage` 增本地优先——URL 是 `/api/media/<id>` 或命中 `getMediaByOriginUrl` 时直接读盘转 data URL（零网络）；`makeAgentTools` 接收 `mediaDir`
- [ ] T125 [S1] `apps/server/src/index.ts`：启动时跑一次 `sweepExpiredMedia`（之后每小时由刀 4 的定时器接管；本刀先只跑启动一次）

**Checkpoint（commit 回滚点）**: `npm run check` + `check:dead` 绿；curl 上传/读回/压缩/清理全通；agent0 能读上传图（单测覆盖）。

---

## 刀 2：前台上传 + 界面渲染 🎯

**Goal**: 对话里可选择/粘贴图片并发送；事项详情、证据引文、原文弹层、聊天气泡把 `[图片](url)` 渲染为图片；过期/未缓存回退链接。

**Independent Test**: 在对话粘贴一张截图 → 气泡显示缩略图 → 发送 → 事项出现「多模态/图片」标签 → 详情与证据里能看到同一张图；把 media 行删掉后再看 → 回退为链接/过期提示。

### Tests（先写并确认 FAIL）

- [ ] T201 [P] [S2] `apps/web/src/test/media.test.tsx`：`[图片](/api/media/x)` 渲染为 `<img>`；非图片占位保持文本；过期回退
- [ ] T202 [P] [S2] `apps/web/src/test/media.test.tsx`：ChatPanel 粘贴/选择 → **本地预览（不上传）** → 点发送才上传 → 正文含占位；每消息最多 1 张（再选 = 替换）；上传失败消息不发、预览保留
- [ ] T203 [P] [S2] `apps/server/src/test/media.test.ts`：`getItemDetail` 的 `media` 映射（原文 URL → MediaRef；过期/缺失不在表里）

### 实现

- [ ] T210 [S2] `apps/server/src/storage/repo.ts`：`getItemDetail` 组装 `media`——扫描批次原文、证据引文的占位 URL，按 `originUrl` / 本地 id 查 media（过期的跳过）
- [ ] T211 [S2] `apps/web/src/api.ts`：`uploadMedia(file)`（原始字节 + `Content-Type`）
- [ ] T212 [S2] `apps/web/src/components/chat/ChatPanel.tsx`：选择按钮 + 粘贴监听 + **本地预览**（object URL）+ 移除（再选 = 替换，最多 1 张）；**点发送才上传**，成功后正文追加 `[图片](/api/media/<id>)`；上传失败消息不发、错误可见、预览保留
- [ ] T213 [S2] 新 `apps/web/src/components/board/MediaImage.tsx`：占位 → `<img>`；未命中按来源回退（**本地 `/api/media/<id>` → 「图片已过期」；外部 URL → 原链接**），点击新标签打开原图
- [ ] T214 [S2] `apps/web/src/components/board/ItemBody.tsx` / `Quotes.tsx` / `QuoteOverlay.tsx`：文本渲染前把可解析占位替换为 `MediaImage`（不可解析保留纯文本）
- [ ] T215 [S2] 聊天气泡：用户消息里的占位同样渲染为图片

**Checkpoint（commit 回滚点）**: `npm run check` + web build 绿；前台传图闭环可演示。

---

## 刀 3：信源图片进站缓存 🎯

**Goal**: nc 消息里的 `[图片](http…)` 在进站后后台缓存；原链接过期后用户仍能看到；原文逐字不变。

**Independent Test**: 模拟一条带图片 URL 的进站批次（测试用本地 HTTP 替身）→ media 行与文件出现；同一 URL 再进站不重复下载；下载失败 stderr 留痕且原占位保留。

### Tests（先写并确认 FAIL）

- [ ] T301 [P] [S3] `apps/server/src/test/media.test.ts`：进站扫描 → 后台缓存（成功/失败/重复 URL）
- [ ] T302 [P] [S3] `apps/server/src/test/media.test.ts`：`ingestBatch` 返回值与原文字节不变

### 实现

- [ ] T303 [S3] `apps/server/src/application/ingest.ts`：落档后异步扫描占位（`extractImageUrls`），并发上限 2；失败 stderr 留痕，不影响进站回执
- [ ] T304 [S3] 复用 `agent0/fetchImage.ts` 的 SSRF 五道闸做下载（抽 `downloadImageBytes(url)`，不编码 data URL）；成功后 `storeImageBytes`（originUrl 记原链接）
- [ ] T305 [S3] 下载上限对齐：进站缓存沿用 20 MiB 输入上限（压缩后 ≤1.9 MiB 入库）；超限/非图片/失败均留痕

**Checkpoint（commit 回滚点）**: `npm run check` 绿；QQ 图过期场景可演示（本地替身断链后仍可见）。

---

## 刀 4：引用判定 + TTL 联动 + 定时清理 🎯

**Goal**: 证据引文引用某图 → 到期时间抬到 `引用时刻 + 90 天`；agent0 读过但未被引用 → digest 结束后缩短到 `min(原值, 读取时刻 + 3 天)`；清理器每小时跑。

**Independent Test**: 造一张「已过期但被引文引用」的图 → 执行写入 → expiresAt 抬到 now+90d；造一张「读过未引用」的图 → digest 结束后 expiresAt = readAt+3d（原值更早则不动）；同一图引用两次 → 以最后一次为准；定时器每小时的清理有单测。

### Tests（先写并确认 FAIL）

- [ ] T401 [P] [S4] `apps/server/src/test/media.test.ts`：引用抬升（`max(当前, 引用时刻 + 90 天)`）；晚到引用可救回被缩到 3 天的图；**同一图多次引用取最后一次**（日期只增不减）
- [ ] T402 [P] [S4] `apps/server/src/test/media.test.ts`：读过未引用 → `min(原值, readAt+3d)`（**原值已 <3 天时不变**）；行已删则忽略
- [ ] T403 [P] [S4] `apps/server/src/test/digest.test.ts`：digest 记录读取集合 → 结束后只对未引用项缩短

### 实现

- [ ] T404 [S4] `apps/server/src/executor/executor.ts`：`attachElementEvidence` 写 quote 时用 `textCitesMedia` 判定 → 命中即 `updateMediaExpiry(max(当前, 引用时刻 + 90 天))`；`executeChanges` 返回 `citedMediaIds`。⚠️ **执行时刻由执行器取 `nowWallClock()`**（不是 `createdAt`）——晚到引用才有意义
- [ ] T405 [S4] `apps/server/src/agent0/digest.ts`：`fetch_image` 成功时记录 media id（本批集合）；`executeChanges` 之后对「读过且不在 citedMediaIds」的项 `updateMediaExpiry(min(原值, readAt+3d))`；更新 0 行静默跳过
- [ ] T406 [S4] `apps/server/src/index.ts`：清理器改为启动一次 + 每小时 `setInterval`（`unref()`，不阻止进程退出）；关停时 clear

**Checkpoint（commit 回滚点）**: `npm run check` 绿；TTL 全规则有断言。

---

## 收尾：文档与发布检查

- [ ] T501 [P] docs/00 数据契约：`media` 表与接口形状
- [ ] T502 [P] docs/01 规格：图片缓存新节（生命周期唯一字段 expiresAt、三档留存：基础 7–30 天 / 读过未引用 3 天 / **引用 90 天**、压缩与上限、动图压缩）
- [ ] T503 [P] docs/02 台账：D-110（图片持久化立项与决策；含放弃项：不做对象存储/不做媒体映射表）
- [ ] T504 [P] docs/03 开放问题、docs/04 验收：登记与结案
- [ ] T505 [P] README「之后的计划」删除「图片持久化」；`CHANGELOG.md` v0.5.0 段落
- [ ] T506 便携包构建（sharp 进包）+ Docker 构建验证；`npm run check` + `check:dead`
- [ ] T507 全仓 grep 复核：旧文案「图片只在处理时临时读取，不落库」等表述逐条更新（01§4.10/README/关于页）
