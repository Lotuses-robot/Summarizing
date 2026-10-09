# Tasks: 对话面板滚动锚定

**Input**: Design documents from `/specs/001-chat-scroll-anchor/`

**Prerequisites**: plan.md ✅, spec.md ✅（无 research.md / data-model.md / contracts/ —— 本特性无未知项、无新数据实体、无对外契约变化）

**Tests**: 包含——宪法 V（真实入口验证）+ spec SC-004 明列测试覆盖要求。

**Organization**: 按 user story 分组，每故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无依赖）
- **[Story]**: 所属 user story（US1 / US2 / US3）

## Path Conventions

本特性为 web 应用前端改动：

```
apps/web/src/components/chat/ChatPanel.tsx   ← 实现
apps/web/src/test/chatPanel.test.tsx          ← 测试
```

---

## Phase 1: Setup

**Purpose**: 无项目级脚手架需求（既有项目）。

- [ ] T001 通读 `apps/web/src/components/chat/ChatPanel.tsx` 与 `apps/web/src/test/chatPanel.test.tsx`，确认消息区容器与既有测试替身（`helpers/http.ts` 喂真实 api.ts）的用法

---

## Phase 2: Foundational (阻塞所有故事)

**Purpose**: 「近底跟随」的公共地基——一个滚动容器 ref + 一个判定/滚动的行为。

**⚠️ 无此阶段，三个故事都无法实现。**

- [ ] T002 [US-shared] 在 `ChatPanel.tsx` 消息区容器（`flex-1 ... overflow-y-auto` 的 div）挂 `ref`，并在组件内加一个 `stickToBottom` 的 ref（记录「当前是否跟随最新」）
- [ ] T003 [US-shared] 加滚动处理函数（带 JSDoc：说明「近底容差」的意图与依据）——判定容器是否在底部附近（容差数十 px），据此更新 `stickToBottom`；函数**必须被真实挂载**（容器 `onScroll`），不得写成无人调用的工具（宪法 IV）
- [ ] T004 [US-shared] 加「滚到底」的执行（`scrollTop = scrollHeight`），供跟随场景调用

**Checkpoint**: 地基就绪，三个故事可分别实现。

---

## Phase 3: User Story 1 - 发送后停在最新消息 (P1) 🎯 MVP

**Goal**: 发送消息后列表自动停在最新消息可见。

**Independent Test**: 渲染面板 → 发送一条 → 断言列表底部可见该消息。

- [ ] T005 [P] [US1] 测试先行：在 `chatPanel.test.tsx` 加「发送后停在底部」断言（渲染含历史的面板 → 发送 → 断言新消息可见 / 容器 scrollTop 在底部），先确认其 FAIL
- [ ] T006 [US1] 实现：`send()` 追加用户消息、以及收到回复追加后，若 `stickToBottom` 为真则滚到底（在设置消息的 `useEffect` 中处理，覆盖两处追加）

**Checkpoint**: US1 独立可用（发完能看到）。

---

## Phase 4: User Story 2 - 刷新后停在底部 (P1)

**Goal**: 历史回填后列表停在最新一条。

**Independent Test**: 有历史时挂载面板 → 断言回填后停在底部。

- [ ] T007 [P] [US2] 测试先行：加「历史回填后停在底部」断言，先确认 FAIL
- [ ] T008 [US2] 实现：历史回填 effect 落地消息后，首次滚动到底（初始挂载即 `stickToBottom = true`）

**Checkpoint**: US1 + US2 均可用（打开/发送都看到最新）。

---

## Phase 5: User Story 3 - 上翻时不被拽回 (P2)

**Goal**: 用户上翻后新消息不抢视口；滚回底部恢复跟随。

**Independent Test**: 造可滚动内容 → 上翻到中部 → 触发新消息 → 断言视口未跳。

- [ ] T009 [P] [US3] 测试先行：加「上翻后新消息不拽回」+「滚回底部恢复跟随」两条断言，先确认 FAIL
- [ ] T010 [US3] 实现：新消息到达时按 `stickToBottom` 决定是否跟随（false 则不动）；`onScroll` 在用户滚回底部时把 `stickToBottom` 置回 true

**Checkpoint**: 三故事全功能。

---

## Phase 6: Polish & Cross-Cutting

- [ ] T011 边界核对（spec Edge Cases）：内容不足无滚动条时无异常；草稿与输入焦点不因滚动丢失；空状态提示不触发滚动
- [ ] T012 运行 `npm run check`（tsc + eslint + vitest）与 `npm run build -w @summarizing/web`，全绿
- [ ] T013 人工走查：真实启动 `npm run dev`，在浏览器验证发消息停在底部、刷新停底、上翻不被拽

---

## Dependencies & Execution Order

- **Phase 1 (Setup)**: 立即可做
- **Phase 2 (Foundational)**: 依赖 Phase 1 —— **阻塞所有故事**
- **US1 / US2 / US3 (Phase 3–5)**: 都依赖 Phase 2；彼此可并行，但改动同处一个 `ChatPanel.tsx`（**同一文件 → 实际串行**，不可标 [P] 并行）
- **Polish (Phase 6)**: 依赖全部故事完成

### Within Each Story

- 测试先写并确认 FAIL，再实现（宪法 V）
- 实现后才进下一故事

## Notes

- ⚠️ 三个故事的实现都落在 `ChatPanel.tsx` 同一文件 → **不可并行**（避免同文件冲突）；测试同落 `chatPanel.test.tsx`
- 每个任务或逻辑组后可 commit（worktree 分支）
- 不确定处停下问（宪法 VI）——尤其「近底容差」取值，采用 spec 默认（数十 px）
