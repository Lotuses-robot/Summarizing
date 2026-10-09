# Implementation Plan: nc 批次信息保真

**Branch**: `003-nc-batch-fidelity` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-nc-batch-fidelity/spec.md`

**Note**: 信源侧自包含改动，无未知项——不生成 research/data-model/contracts。

## Summary

nc 组批从「无署名行 + 批次级 sender=最后一条」改为**行协议**：每行 `[HH:mm] 发送者（群身份）: 内容`（跨天升级日期），正文逐字保真；`sourceIdentity.sender` 仅唯一发送者时写。引文逐字校验不受影响（前缀只在行首，消息正文连续）。

## Technical Context

**Language/Version**: TypeScript 5.x strict

**Primary Dependencies**: 无新增（zod 既有）

**Storage**: 无变化（content 存组批后文本——它就是「批次原文」，引文对它校验）

**Testing**: Vitest（nc.test.ts 组批断言更新 + 新增四类场景）

**Target Platform**: server

**Project Type**: 信源适配器（自包含模块）

**Performance Goals**: N/A

**Constraints**: 正文逐字保真；协议只在信源侧（core 不解析）

**Scale/Scope**: `sources/nc/{types,index}.ts` + `nc.test.ts` + 两个文档

## Constitution Check

| 宪法条款 | 合规 | 说明 |
|----------|:---:|------|
| 产品不变量「原文先行/证据链」 | ✅ | 正文保真是 FR-002；引文子串兼容有断言（SC-002） |
| 高频禁区（相对日期不按接收兜底） | ✅ | 行内时刻取消息自带时刻 |
| IV 无调用者不写 | ✅ | 行协议函数即 assembleBatch 本体，无旁路工具 |
| 职责划分（D-91 前序讨论） | ✅ | 信源管批内拼接（第一层），协议是信源私有约定 |
| 自审三问 | ✅ | 02 台账记 D-91；07/SOURCE-GUIDE 同步 |

**结论**：通过。

## Project Structure

### Source Code

```text
apps/server/src/sources/nc/
├── types.ts    # 改：NcEventSchema +sender.role；BufferedEvent +role；assembleBatch 行协议；SealedBatch.sender 可选
└── index.ts    # 改：BufferedEvent 带 role；sourceIdentity 条件展开 sender
apps/server/src/test/nc.test.ts    # 改：组批断言更新 + 四类新场景
docs/07-接新源检查单.md            # 改：增补行协议规范段
SOURCE-GUIDE.md                    # 改：组批示例同步
```

**Structure Decision**: 全在 nc 模块内（自包含红线）；shared 契约不动。

## Complexity Tracking

无违反项。
