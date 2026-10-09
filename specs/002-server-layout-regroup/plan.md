# Implementation Plan: 服务端目录重组

**Branch**: `002-server-layout-regroup` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-server-layout-regroup/spec.md`

**Note**: 纯结构重组，无未知项——不生成 research.md / data-model.md / contracts/。

## Summary

`apps/server/src` 从「features 兜底目录」重组为「按职责命名」：`agent0/`（执行者）+ `executor/`（变更写通道）+ `application/`（对外能力编排层），`errText` 归位 `shared/`。零行为变化，import 全量同步。

## Technical Context

**Language/Version**: TypeScript 5.x strict / Node ≥22

**Primary Dependencies**: 无新增

**Storage**: 无变化

**Testing**: Vitest（229 条既有测试即行为回归网）

**Target Platform**: 同既有

**Project Type**: monorepo 内 `apps/server`

**Performance Goals**: N/A

**Constraints**: 零行为变化；`git mv` 保历史

**Scale/Scope**: ~10 文件移动/新建，~13 文件 import 更新

## Constitution Check

| 宪法条款 | 合规 | 说明 |
|----------|:---:|------|
| III 模块数量受控/目录名说得出是什么 | ✅ | 本轮正是消灭无判据目录；`application/` 与 `app.ts` 并存无解析歧义（import 均带子路径） |
| IV 不写没有调用者的东西 | ✅ | 无新抽象；`errText` 迁移有既有调用者 |
| V 在真实入口验证 | ✅ | 既有 229 测试 = 行为零变化回归网 |
| 自审三问 | ✅ | grep 扫 `features/` 残留；docs/07 同步；02 台账记 D-90 |

**结论**：通过。

## Project Structure

### Source Code (repository root)

```text
apps/server/src/
├── agent0/            # ← features/agent0（digest/prompt/tools/sweep 留此）
├── executor/          # ← agent0/{fence,executor}.ts（变更写通道）
├── application/       # ← features/{ingest,board,chat}.ts
├── shared/err.ts      # ← agent0/digest.ts 的 errText 迁出
└── （routes/ sources/ storage/ 不动）
```

**Structure Decision**: 用户 2026-10-09 拍板（`application/` 暂定）；三组 `git mv` + import 矩阵 + 两处观察项注释。

## Complexity Tracking

无违反项。
