# Implementation Plan: Token 用量统计

**Branch**: `010-token-stats` | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)

## Summary

在 LLM 客户端出口采集 `usage`，每次成功调用落一行 `llm_usage`（存服务商原始值）；`GET /api/usage` 按时间范围聚合**三个互不重叠的总量**——**未命中输入**（`prompt − cached`）、输出、缓存命中；活动栏左下角新增独立「用量」按钮，打开**三个大号数字的简单仪表盘**（不做图表/表格/拆分列表）。缓存命中按服务商实际返回显示，缺字段明确写「服务商未提供」。

## Technical Context

**Language/Version**: TypeScript / Node 22+
**Primary Dependencies**: 现有 `openai` SDK（`res.usage.prompt_tokens_details.cached_tokens` 已在类型中）
**Storage**: 用户库新增 `llm_usage` 表（**schema v2 → v3**；010 先落地——随后的 009 再 3→4）
**Testing**: Vitest 服务端真实入口 + 前端 happy-dom
**Constraints**: usage 缺失不崩；不伪造缓存命中；数值三类分开

## Constitution Check

- ✅ 不静默：usage 缺失/脏值 stderr 留痕
- ✅ 可见性：用量是用户可见的诚实数字
- ✅ 无新依赖
- ✅ 模块数量受控：**不新增主视图/设置分区**，只加一个左下角按钮 + 弹层（与 About/User 弹层同构）

## Project Structure

```text
packages/shared/src/index.ts          # LlmUsage / UsageSummary 类型
apps/server/src/shared/llm.ts         # chat 返回 usage（zod 解析脏值）
apps/server/src/storage/schema.ts     # llm_usage 表
apps/server/src/storage/db.ts         # 建表 DDL
apps/server/src/storage/migrate.ts    # SCHEMA_VERSION 2 → 3（010 独占；009 后续 3→4）
apps/server/src/storage/repo.ts       # 插入 / 聚合查询
apps/server/src/routes/usage.ts       # GET /api/usage
apps/server/src/agent0/digest.ts      # actor=agent0 落行
apps/server/src/application/chat.ts   # actor=chat 落行
apps/web/src/components/ActivityBar.tsx   # 左下角新增「用量」按钮（ChartColumn）
apps/web/src/components/UsageModal.tsx    # 新增：只读用量弹层（三类分开）
apps/web/src/App.tsx                  # 弹层开关
apps/web/src/api.ts                   # usage()
```

## 影响面清单（必填）

| 变更的符号/值/枚举 | 全部消费点 | 本轮同步动作 |
|---|---|---|
| `LlmClient.chat` 返回值 | `digest.ts` / `chat.ts` / `sweep.ts` / 测试 FakeLlm | 增加可选 `usage`；fake 不填也不破坏 |
| `SCHEMA_VERSION` 2→3 | 009 后续 3→4 / 迁移测试 | 010 先落地占用 3；两特性顺序做，不合并迁移 |
| `ActivityBar` props | `App.tsx` | 新增 `onOpenUsage`；左下角按钮组加一个入口 |
| `View` 联合类型 | 不受影响（用量是弹层，不是主视图） | 不改 |

## Complexity Tracking

无违规。用量入口是弹层（与 About/User 同构），不新增主视图与设置分区。
