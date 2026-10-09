# Tasks: 服务端目录重组

**Input**: Design documents from `/specs/002-server-layout-regroup/`

**Prerequisites**: plan.md ✅ spec.md ✅（无 research/data-model/contracts——纯重组）

## Format: `[ID] [P?] [Story] Description`

## Phase 1: 移动

- [x] T001 `git mv` 三组：`features/agent0 → agent0`；`agent0/{fence,executor}.ts → executor/`；`features → application`（保历史）

## Phase 2: import 矩阵

- [x] T002 [P] `shared/err.ts` 新建（errText 迁出）；`agent0/digest.ts` 删原定义并 import
- [x] T003 [P] `executor/{fence,executor}.ts` 相对 import `../../` → `../`（storage/shared）
- [x] T004 `agent0/{digest,sweep}.ts` 的 `./fence`/`./executor` → `../executor/*`
- [x] T005 [P] `application/{chat,ingest}.ts` 的 `./agent0/*` → `../agent0/*`；chat 的 errText 改 `../shared/err`
- [x] T006 [P] `app.ts`（agent0 路径 + errText→shared/err）、`index.ts`、`routes/{settings,uncertain}.ts`
- [x] T007 [P] 五个测试文件 import 更新（board/chat/digest/fence/repo/uncertain.test）

## Phase 3: 文档与标记

- [x] T008 [P] `application/chat.ts` 与 `agent0/sweep.ts` 头部加观察项注释
- [x] T009 [P] `docs/07` 的 `features/chat.ts` → `application/chat.ts`
- [x] T010 [P] `docs/02-决策台账` 追加 D-90

## Phase 4: 质量门

- [x] T011 `grep -rn "features/" apps/server/src scripts` 零残留
- [x] T012 `npm run check` + `npm run check:dead` + web 构建全绿

## Notes

- 三故事同落一处（本轮无 user story 分层——重组是原子事务，只有全绿一个检查点）
- sed 仅用精确字符串替换，改后 grep 逐条复核（自审红线）
