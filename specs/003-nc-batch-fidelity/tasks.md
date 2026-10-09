# Tasks: nc 批次信息保真

**Input**: Design documents from `/specs/003-nc-batch-fidelity/`

**Prerequisites**: plan.md ✅ spec.md ✅

## Format: `[ID] [P?] [Story] Description`

## Phase 1: 类型与协议（US1–US3 共用地基）

- [x] T001 `nc/types.ts`：`NcEventSchema.sender` 增 `role`（owner/admin/member，optional）；`BufferedEvent` 增 `role`
- [x] T002 `nc/types.ts`：`assembleBatch` 行协议（时间前缀/角色括注/跨天升级/正文保真）+ `SealedBatch.sender` 可选（唯一发送者才写）

## Phase 2: 投递

- [x] T003 `nc/index.ts`：`BufferedEvent` 构造带 `role`；`sealGroup` 的 `sourceIdentity` 条件展开 `sender`

## Phase 3: 测试（US1/US2/US3 + 边界）

- [x] T004 [P] 测试先行：`nc.test.ts` 更新既有组批断言（旧格式会 FAIL）后实现 T001–T003 再转绿
- [x] T005 [P] 新增断言：多人批次逐行署名 / 单人批次 sender 存在 / 多人省略 / admin 括注 / member 无噪声 / 跨天格式 / 引文子串兼容

## Phase 4: 文档与收口

- [x] T006 [P] `docs/07` 增补「批次行协议」规范段（判据：信源侧约定，core 不解析）
- [x] T007 [P] `SOURCE-GUIDE.md` 组批示例同步
- [x] T008 [P] `docs/02-决策台账` 追加 D-91
- [x] T009 `npm run check` 全绿 + knip + web 构建

## Notes

- 正文逐字保真是硬约束（引文校验依赖）——协议字符只出现在行首前缀
- 每任务后 `npx vitest run apps/server/src/test/nc.test.ts` 快速回环
