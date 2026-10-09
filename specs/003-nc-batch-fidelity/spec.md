# Feature Specification: nc 批次信息保真（行协议 + 身份修正）

**Feature Branch**: `003-nc-batch-fidelity`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "打包时发言人被折叠成一个，AI 以为多句话是同一人发的——信息失真。每行要带时间与发送者（含群身份），批次级 sender 不再说谎"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 多人连发不失真 (Priority: P1)

群里多人连发若干条消息被打包成一个批次后，AI 看到的每一行都自带发送者与时刻——不再把整批归给最后一个人。

**Why this priority**: 这是用户实测发现的失真本体——归属错误直接污染事项的「谁的事」。

**Independent Test**: 构造甲、乙两人各发多条的批次，断言组批结果每行含对应发送者名字。

**Acceptance Scenarios**:

1. **Given** 甲发 2 条、乙发 1 条（同窗打包），**When** 组批，**Then** 3 行各带 `[时刻] 甲/乙:` 前缀，正文逐字未改。
2. **Given** 单人连发多条，**When** 组批，**Then** 每行同样带时刻与发送者（协议统一，不因单人多关）。

---

### User Story 2 - 批次身份不再说谎 (Priority: P1)

批次级 `sourceIdentity.sender` 只在「批内唯一发送者」时写；多人批次省略该键——不再拿「最后一条的发送者」冒充整批发信人。

**Why this priority**: 身份对象是矛盾取舍的权威性判据，假数据比没数据糟。

**Independent Test**: 多人批次断言 `sender` 键不存在；单人批次断言等于该人。

**Acceptance Scenarios**:

1. **Given** 多人批次，**When** 封批，**Then** `sourceIdentity` 无 `sender` 键（`groupId`/`sourceLabel` 照旧）。
2. **Given** 单人批次，**When** 封批，**Then** `sender` = 该发送者。

---

### User Story 3 - 群身份可见 (Priority: P2)

发信人的群角色（群主/管理员）进正文行与批内署名语境——AI 判权威性时有据（官方群 > 班级群 > 个人；管理员发言 > 普通成员）。

**Why this priority**: 权威性判断的增强项；失真本体（US1/US2）先解决。

**Independent Test**: role=admin 的事件组批后行内出现「（管理员）」；member/缺席不产生噪声。

**Acceptance Scenarios**:

1. **Given** role=admin，**When** 组批，**Then** 该行显示「张三（管理员）」。
2. **Given** role=member 或缺席，**When** 组批，**Then** 行内无身份括注。

### Edge Cases

- **跨天批次**（首末消息日期不同）：时刻前缀升级为 `[MM-DD HH:mm]`，避免歧义。
- **跨消息引文收紧（刻意）**：行前缀插入非空白——「跨两条消息拼的引文」从旧版碰巧能过变为被围栏拒（那种引文本就不是单条消息的逐字；fence 有断言）。
- **已接受残余风险**：消息正文本身无法消毒（逐字保真是硬约束），成员可在正文伪造协议行——记录在案（D-91/docs/07），勿以转义正文来「修」（会断引文校验）。
- **多行消息**：续行缩进两空格以维持「每条一行有前缀」；引文校验按空白归一比对，不受缩进影响（评审修正）。
- **引文兼容**：对单条消息正文的逐字引文必须仍是整批 content 的子串（前缀只加在行首）。
- **群备注名**：`sourceLabel` 逻辑不变（白名单备注名）。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 组批正文 MUST 为逐行 `[HH:mm] 发送者（身份）: 内容` 格式（跨天批次 `[MM-DD HH:mm]`）。显示名 MUST 经净化：换行折空格、全部半角冒号换全角、剥「（群主）/（管理员）」字面量、尾部冒号剥除——净化后为空 MUST 退回 senderId 或「未知」（二/三轮评审）。
- **FR-002**: 消息正文 MUST 逐字保真（空白归一层面——多行消息续行缩进两空格以维持行协议，评审修正）。
- **FR-003**: 群角色 owner/admin（小写归一）MUST 显示为「群主/管理员」；member、缺席、null 与未知值 MUST 不显示；角色字段收宽松形状（含 null）MUST NOT 导致事件被丢（评审修正）。
- **FR-004**: `sourceIdentity.sender` MUST 仅在「可确证唯一发送者」时存在——任一事件缺 senderId 的多消息批次 MUST 省略（宁缺勿谎，三轮评审）；显示名兜「未知」时 MUST 不署名（五轮评审）。
- **FR-005**: 事件 schema MUST 宽松解析：`sender.role`（string/数字/null/缺席均不丢事件）与 `nickname/card/user_id/raw_message/time/message/段 data` 的同款 null 容忍（三轮评审——严格形状会让整条事件 safeParse 失败 → 204 静默丢）。
- **FR-006**: 消息缺真时刻（桥接发 null/缺席）→ 批次 `eventTime` MUST 置 null（**禁按接收时刻兜底**——01§5.3 红线，五轮评审）；接收时刻仅可用于去抖与行前缀等机械用途，MUST NOT 进入 eventTime。

### Key Entities

无新表。`NcEventSchema` 扩展 `sender.role`；`BufferedEvent` 增加 `role`；`SealedBatch.sender` 变为可选。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 多人/单人/跨天/带角色四类组批各有单元断言（assembleBatch 纯函数直测）。
- **SC-002**: 引文逐字兼容有断言（消息正文引文仍是 content 子串）。
- **SC-003**: `npm run check` 全绿（含全部既有 nc/消化测试）。

## Assumptions

- 仅改 nc 信源（weflow 搁置中，未跟踪不入库）；手打/对话源无此问题。
- **时刻语义（FR-006）**：真时刻优先；桥接发 null → 批次 `eventTime=null`（下游本就支持「日期未知」，禁接收兜底）；接收时刻仅用于去抖与行前缀等机械用途。
- 协议是信源侧约定（core/agent0 只当文本读），不进 shared 契约。
- 已接受残余风险：成员可在消息正文伪造协议行（正文不可消毒）——记录于 D-91/docs/07，勿以转义正文「修」它。
