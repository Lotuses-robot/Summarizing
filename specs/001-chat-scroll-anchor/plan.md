# Implementation Plan: 对话面板滚动锚定

**Branch**: `001-chat-scroll-anchor` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-chat-scroll-anchor/spec.md`

**Note**: 本特性为既有面板的交互修正，范围小、无未知项——不生成 research.md / data-model.md / contracts/（无新数据实体、无对外契约变化）。

## Summary

对话面板（`apps/web/src/components/chat/ChatPanel.tsx`）的消息列表当前**没有任何滚动管理**（容器无 ref、无滚动逻辑）：发送后新消息长在视口外，刷新回填后停在顶部。本特性为其加入**「近底跟随」**：默认跟随最新消息；用户上翻离开底部后不被新消息拽回；滚回底部后恢复跟随。

## Technical Context

**Language/Version**: TypeScript 5.x（strict）/ React 19

**Primary Dependencies**: 既有 web 栈（React + Tailwind v4），不新增依赖

**Storage**: N/A（纯前端交互，无持久化变化）

**Testing**: Vitest + happy-dom + @testing-library/react（既有 web 自测基建，`apps/web/src/test/*.test.tsx`）

**Target Platform**: 浏览器（桌面停靠 + 窄屏浮层共用同一组件）

**Project Type**: Web 应用（`apps/web` 前端）

**Performance Goals**: 滚动响应无感知延迟（同步，无网络）

**Constraints**: 不改消息发送/存储/渲染逻辑；不引入虚拟滚动

**Scale/Scope**: 单组件（ChatPanel.tsx）+ 其测试文件

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 宪法条款 | 本方案是否合规 | 说明 |
|----------|:---:|------|
| I 先跑通完整业务循环 | ✅ | 修正既有主循环中的交互瑕疵，无新增结构 |
| III 模块数量受控 / 不引入非必要抽象 | ✅ | 不新增模块、不新增依赖；改动限于一个组件内 |
| IV 不写没有调用者的东西 | ⚠️ 需注意 | 滚动逻辑**必须被真实使用**（附着在消息区），不得写成无人调用的工具函数 |
| V 在真实入口验证 | ✅ | 测试走真实组件渲染（happy-dom），断言用户所见（消息可见/位置） |
| VI 不确定先问 | ✅ | 无歧义（spec 的假设已列明容差与范围） |
| 工程红线：类型严格、JSDoc | ✅ | 用 ref + effect；新函数带 JSDoc |
| 高频禁区 | ✅ | 不涉及（无日期/事项/存疑相关） |
| 质量门 `npm run check` | ✅ | 须过 tsc + eslint + vitest |

**结论**：通过，无违反项，无需 Complexity Tracking。

## Project Structure

### Documentation (this feature)

```text
specs/001-chat-scroll-anchor/
├── spec.md              # 需求规格（已生成）
├── plan.md              # 本文件
├── checklists/
│   └── requirements.md  # 规格质量清单（已生成）
└── tasks.md             # 由 /speckit-tasks 生成
```

### Source Code (repository root)

```text
apps/web/src/
├── components/chat/ChatPanel.tsx     # 改：消息区容器加 ref + 滚动锚定 effect
└── test/
    ├── chatPanel.test.tsx            # 改：补滚动行为断言
    └── helpers/                      # 既有测试基建，复用
```

**Structure Decision**: 单文件改动（+ 测试），落在既有 `apps/web` 结构内，不新建目录。

## Complexity Tracking

> 无违反项，本表不填。
