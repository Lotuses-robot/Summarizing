# Implementation Plan: 图片持久化（前台上传 + 信源图片缓存）

**Branch**: `009-image-persistence` | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-image-persistence/spec.md`

## Summary

把「图片」从一次性读取升级为**有期限的本地缓存**：前台可上传（对话粘贴/选择），信源图片进站即后台抓取；**两路共用同一套逻辑**——同一个 `application/media.ts`（校验 → 压缩 → sha256 去重 → TTL 计算 → 落盘），同一个 `data/media/<uid>/` 文件库 + 用户库 `media` 表。超过 500 KiB 的图由 sharp 压缩到 500 KiB 以下（**动图同样压缩**——降帧/丢帧，并提示动画被压缩），保证 agent0 永远可读。留存三档：普通按大小反向 7–14 天；读过未引用缩到 3 天；**被证据引用则延长到 90 天**（证据链不断）。到期由进程内清理器删除并留痕。原文 `[图片](url)` 占位**逐字不变**，界面按 media 映射解析为图片。**前台 v1 不直接读图**。

## Technical Context

**Language/Version**: TypeScript 5.x / Node 22+
**Primary Dependencies**: 新增 `sharp`（用户 2026-10-20 拍板）；Fastify 现有栈
**Storage**: 文件 `data/media/<uid>/<sha256>.<ext>` + 用户库 `media` 表（**schema v3 → v4**；010 先落地占 3）
**Testing**: Vitest（服务端真实入口：HTTP + 真实库；前端 happy-dom）
**Target Platform**: Linux 容器（node:22-slim，glibc）+ Windows 便携包
**Performance Goals**: 单图压缩 <2s（典型照片）；进站下载并发上限 2
**Constraints**: 2C2G 服务器；压缩后 ≤500 KiB；输入 ≤20 MiB / 25MP
**Scale/Scope**: 个人中枢单账户；缓存量由 TTL 自然上限

## Constitution Check

- ✅ 六条纪律：先跑通完整循环（上传→AI 读→证据可见）；阶段结束可独立使用
- ✅ 不写没有调用者的东西：media 表/清理器/压缩均有直接调用方
- ✅ 静默禁止：下载失败、压缩失败、拒收、过期删除全部可见留痕
- ✅ 原文逐字：不动 raw_inputs / fragments；只旁挂 media
- ✅ 类型绕过禁止：所有新边界用 zod schema
- ⚠️ 新依赖 `sharp`：已在 Phase 1 提案并经用户批准；打包影响见下

## Project Structure

```text
apps/server/src/
├── storage/
│   ├── schema.ts          # 新增 media 表
│   ├── db.ts              # ensureSchema 建表 DDL
│   ├── migrate.ts         # SCHEMA_VERSION 3 → 4
│   └── repo.ts            # media CRUD / 查询
├── application/
│   ├── media.ts           # 新增：存储/压缩/解析/留存计算/清理
│   └── ingest.ts          # 进站后扫描图片占位 → 后台缓存
├── routes/
│   └── media.ts           # 新增：POST /api/media、GET /api/media/:id
├── agent0/
│   ├── fetchImage.ts      # 本地媒体优先 + 成功持久化
│   └── tools.ts           # fetch_image 接线
├── executor/executor.ts   # 写 quote 时标记引用
├── app.ts                 # 注册路由/bodyLimit/日志脱敏
└── index.ts               # 启动清理器

apps/web/src/
├── api.ts                 # uploadMedia
├── components/chat/ChatPanel.tsx      # 选择/粘贴/预览
├── components/board/ItemBody.tsx      # 图片渲染
├── components/board/Quotes.tsx        # 引文图片渲染
└── components/board/QuoteOverlay.tsx  # 原文弹层图片渲染

packages/shared/src/index.ts             # Media 类型 / GetItemResult.media
```

**Structure Decision**: 沿用 server 的 `application / routes / storage / agent0` 分层；媒体文件走 `data/` 旁挂目录，不引入对象存储。

## 影响面清单（必填）

| 变更的符号/值/枚举 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `SCHEMA_VERSION` 3→4 | `migrate.ts` / `db.ts` ensureSchema / 迁移测试 | 010 已占 3；009 再 +1（纯建表） |
| `GetItemResult` 增 `media` | `repo.getItemDetail` / `executor` 引文 / `ItemBody` / `Quotes` / `QuoteOverlay` / agent0 `get_item` 工具 | shared schema + 组装 + 前端消费（key = 原文占位 URL） |
| `fetchImage` 返回值/语义 | `agent0/tools.ts` / `digest.ts` | 本地媒体优先；保持 `ok:false` 降级契约 |
| `ingestBatch` 返回 | 路由与 `SourceContext.ingest` | 返回值不变；后台缓存异步启动 |
| `[图片](url)` 占位格式 | `sources/nc/index.ts` 生成 / prompt / fence 引文校验 / 前端渲染 | 不改生成；新增解析器 |

## 打包与依赖（sharp）

- `apps/server/package.json`：`sharp` 进 dependencies
- `scripts/build-server.mjs`：`external` 加 `"sharp"`
- `Dockerfile` runtime：拷 `sharp` + `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64` + `semver`/`detect-libc`/`@img/colour`
- `scripts/build-release.mjs`：拷 `sharp` + `@img/sharp-win32-x64` + 三个小包
- 体积：便携包约 +20 MB；镜像约 +19 MB

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| 新增原生依赖 sharp | 压缩是 CPU/内存敏感操作 | jimp 在 2C2G 上大图有尖峰；WASM 维护弱 |
| 新增后台缓存任务 | QQ 链接小时级过期 | 懒加载（只在 agent0 读时存）会让未读图永久丢失 |
| 进程内定时清理器 | TTL 缓存必须有回收 | 只在进站时清理，长期无新消息则永不释放 |
| 引用图延长到 90 天 | 证据链必须始终可查（01§4.4） | 沿用 30 天上限会让「每块可查回原文」在图上失效 |
