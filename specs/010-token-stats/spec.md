# Feature Specification: Token 用量统计

**Feature Branch**: `010-token-stats`

**Created**: 2026-10-20

**Status**: Draft（待批准）

**Input**: 用户 2026-10-20：
- 「这一个版本顺便加个统计功能，统计流过的 token，话说可以知道有多少是缓存命中吗」
- 「用量的查看不放在设置里吧，放在别的地方吧；要不就单开一个左下角的按钮；然后缓存和输入输出都分开统计哦」
- 复查拍板（2026-10-20）：**「输入」= 未命中部分**（三个数字互不重叠，相加 = 总消耗）。

## User Scenarios & Testing

### User Story 1 - 查看 token 用量 (Priority: P1)

用户在活动栏**左下角**点一个独立的「用量」按钮，打开一个**简单仪表盘**：三个大号数字——**未命中输入 token、输出 token、缓存命中 token**，各自独立、**互不重叠**（三者相加 = 总消耗）；上方可切今日 / 近 7 天 / 近 30 天。

**Why this priority**：用量是自托管用户最关心的成本指标；缓存命中单独可见，才知道「省了多少」。

**Independent Test**：发起一次消化 → 打开用量弹层 → 三个数字分别增加，且与本次调用 usage 一致。

**Acceptance Scenarios**：

1. **Given** 一次成功调用返回 usage，**When** 打开用量弹层，**Then** 看到三个大号数字：未命中输入 / 输出 / 缓存命中，三者相加 = 该次调用的 prompt + completion。
2. **Given** 一次调用的 `prompt_tokens=1000`、`cached_tokens=800`，**When** 查看用量，**Then** 未命中输入显示 **200**（不是 1000），缓存命中显示 800——不重复计数。
3. **Given** 服务商不返回缓存字段，**When** 查看用量，**Then** 缓存位置显示「服务商未提供」，未命中输入此时 = 全部 prompt。
4. **Given** 切换今日 / 7 天 / 30 天，**When** 查看，**Then** 三个数字随范围变化。
5. **Given** 用户不在设置里找用量，**When** 想看待办以外的成本信息，**Then** 左下角按钮一眼可达（与账户/设置/关于同组）。

### Edge Cases

- usage 整段缺失 / `prompt_tokens` 或 `completion_tokens` 缺失 → 不落行（stderr 留痕）。**0 是合法值**，不当作脏数据。
- 负数 / 小数 / 字符串 / NaN → 形状非法，整条 usage 判为不可用，不落行并留痕。
- 一次消化多轮工具调用 → 每轮一行，累加正确。
- 切换模型 → 行上记录 model（留痕属性），**v1 界面不按模型分组**（与 FR-005 一致）。
- 用量行很多时 → 按 `at` 索引查询；每次查询只扫所选范围。
- 账户隔离 → 每账户一库，无跨账户泄漏。
- 「AI 测试连接」探针调用 → **不计入**（它不经过统一的用量记录点；测一次连接不是真实消耗场景的统计对象）。

## Requirements

### Functional Requirements

- **FR-001**: `LlmClient.chat` MUST 返回 `usage`（prompt / completion / cached；缺少为 null）。
- **FR-002**: 每次成功调用 MUST 在用户库 `llm_usage` 表落一行（at / actor / model / promptTokens / completionTokens / cachedTokens；actor/model 是留痕属性，v1 界面不展示拆分）。**存原始值**（prompt 含缓存）——未命中部分在聚合时算。
- **FR-003**: `GET /api/usage?range=today|7d|30d` MUST 返回三个维度，**互不重叠**：
  - `inputTokens` = `Σ(promptTokens − (cachedTokens ?? 0))`（未命中部分）
  - `completionTokens` = `Σ(completionTokens)`
  - `cachedTokens` = `Σ(cachedTokens)`；**为 null ⇔ 区间内所有调用都没有缓存字段**
  - 三者相加 = 区间总消耗。范围口径 = **北京墙钟的日历日**：`today` = 今日 00:00 起；`7d` = 含今日的 7 个日历日；`30d` = 含今日的 30 个日历日。
- **FR-004**: 前端 MUST 在**活动栏左下角**新增独立「用量」入口按钮（与账户/设置/关于同组），点击打开只读用量弹层；**不放进设置**。
- **FR-005**: 弹层 v1 MUST 是**三个大号数字**的简单仪表盘（未命中输入 / 输出 / 缓存命中），不做图表、表格与拆分列表。
- **FR-006**: 弹层 MUST 支持今日 / 近 7 天 / 近 30 天切换；默认近 7 天。
- **FR-007**: usage 缺失/脏值时 MUST 不崩、不落行，并 stderr 留痕（不静默）。
- **FR-008**: 用量查询 MUST 按账户隔离（每账户一库）。

### Key Entities

- **LlmUsage**：一次调用的用量行；at、actor（agent0/chat）、model、prompt/completion/cached（**均为服务商原始值**）。
- **UsageSummary**：按范围聚合后的**三个互不重叠的总量** + `callCount`（零调用与零用量可区分）。v1 不返回按 actor / model 的拆分。

## Success Criteria

- **SC-001**: 一次真实消化后，弹层三个数字与本次调用 usage 一致。
- **SC-002**: 缓存字段存在时单独显示；不存在时显示「服务商未提供」。
- **SC-003**: 用量入口在活动栏左下角，不进入设置面板。
- **SC-004**: `npm run check` 全绿；真实入口断言界面数值。

## Assumptions

- OpenAI 兼容服务商对 usage 的支持不一致；统计以「有什么显示什么」为原则。
- 用量数据量小（个人中枢），不做采样或聚合表，直接按时间范围查询。
- **迁移版本号**：010 先落地（顺序做），占 `SCHEMA_VERSION` 2→3；随后的 009 再 3→4。
