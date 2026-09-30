// 演示数据种子（公开：`npm run seed:demo`）——清空当前库并写入一套**虚构**样例：
// 大学生场景的 8 个事项 / 8 条批次原文 / 2 条存疑 / 4 轮对话 / 信源设置。
// 用途：截图、演示、新机器体验。⚠️ 会清空现有数据（先自行备份：data/backup/）。
import { randomUUID } from "node:crypto";
import { SettingFieldSchema } from "@summarizing/shared";
import { makeDb } from "../apps/server/src/storage/db";
import * as repo from "../apps/server/src/storage/repo";
import { makeNcAdapter } from "../apps/server/src/sources/nc";

const DB_PATH = "data/summarizing.db";
const MODEL = "deepseek-flash";
const BY = { actor: "agent0", model: MODEL };

/** 本地墙钟串：now 往前推 ms 毫秒（与 repo 的 receivedAt/at 同格式）。 */
function wallClockAgo(ms: number): string {
  const d = new Date(Date.now() - ms);
  /** 两位数补零。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

const db = makeDb(DB_PATH);
const client = db.$client;

// ── 清空（顺序无关，无外键约束）──
for (const t of [
  "item_versions",
  "fragments",
  "evidence",
  "raw_inputs",
  "item_views",
  "app_settings",
  "source_settings",
  "uncertain_inputs",
  "chat_turns",
  "replay_nodes",
]) {
  client.prepare(`DELETE FROM ${t}`).run();
}

// ── 批次原文（全部虚构）──
type RawSeed = {
  content: string;
  sourceLabel: string;
  sender: string;
  groupId: string;
  receivedAt: string;
};
const raws: RawSeed[] = [
  {
    content:
      "【课程设计】数据结构大作业：实现一个图书管理系统（图书增删改查 + 读者管理），10 月 8 日前把设计文档和源码打包交到教学网。",
    sourceLabel: "学习交流群",
    sender: "班长 小林",
    groupId: "10001",
    receivedAt: wallClockAgo(3 * DAY),
  },
  {
    content: "图书馆提醒：《算法导论》应还日期为 10 月 5 日，可在图书馆公众号续借一次。",
    sourceLabel: "班级通知群",
    sender: "图书馆",
    groupId: "10002",
    receivedAt: wallClockAgo(1 * DAY),
  },
  {
    content: "关于期中考试安排：高等数学期中考试定于第 8 周周四下午 14:00–16:00，考场另行通知。",
    sourceLabel: "学习交流群",
    sender: "学习委员",
    groupId: "10001",
    receivedAt: wallClockAgo(2 * DAY),
  },
  {
    content: "入学体检复查提醒：有复查项目的同学请携带学生卡到校医院二楼登记复查。",
    sourceLabel: "班级通知群",
    sender: "辅导员",
    groupId: "10002",
    receivedAt: wallClockAgo(5 * DAY),
  },
  {
    content: "校程序设计竞赛来啦！三人一队，先到竞赛平台组队再报名，截止时间见平台公告。",
    sourceLabel: "社团大群",
    sender: "社长",
    groupId: "10003",
    receivedAt: wallClockAgo(4 * DAY),
  },
  {
    content: "《形势与政策》论文今天 24 点前交到课程群作业，3000 字、主题自选。",
    sourceLabel: "班级通知群",
    sender: "学委",
    groupId: "10002",
    receivedAt: wallClockAgo(6 * DAY),
  },
  {
    content: "本周六招新摊位值班，报名接龙：小林、阿凯、我。",
    sourceLabel: "社团大群",
    sender: "社长",
    groupId: "10003",
    receivedAt: wallClockAgo(9 * DAY),
  },
  {
    content: "帮我记一下，10 月 1 日要和导师开组会讨论选题。",
    sourceLabel: "前台对话",
    sender: "我",
    groupId: "",
    receivedAt: wallClockAgo(30 * 60_000),
  },
];

const rawIds: string[] = [];
raws.forEach((r, i) => {
  const sourceType = i === raws.length - 1 ? "chat" : "nc";
  const row = repo.insertRawInput(db, {
    content: r.content,
    sourceType,
    sourceIdentity: { sourceLabel: r.sourceLabel, groupId: r.groupId, sender: r.sender },
    receivedAt: r.receivedAt,
    eventTime: r.receivedAt,
  });
  repo.setDigestState(db, row.id, "digested");
  rawIds.push(row.id);
});

/** 从批次 i 里逐字取一段做片段（demo 引文 = 原文子串）。 */
function fragFrom(rawIndex: number, quote: string): string {
  const rawId = rawIds[rawIndex];
  if (rawId === undefined) throw new Error(`批次 ${rawIndex} 不存在`);
  return repo.getOrCreateFragment(db, quote, rawId).id;
}

/** 建一个事项（单版本）——返回 itemId。 */
function makeItem(
  action: string,
  detail: string,
  snapshot: {
    elements: { label: string; text: string; note?: string | null }[];
    tags: string[];
    status: "todo" | "done" | "archived";
    doubtNote: string | null;
  },
  atAgoMs: number,
): string {
  const itemId = randomUUID();
  const v = repo.appendItemVersion(db, { itemId, action, detail, snapshot, by: BY });
  client.prepare("UPDATE item_versions SET at = ? WHERE id = ?").run(wallClockAgo(atAgoMs), v.id);
  return itemId;
}

/** 挂证据：元素 subject + 片段 + 批次指针。 */
function ev(itemId: string, subject: string, fragId: string): void {
  repo.addEvidence(db, {
    itemId,
    subject,
    fragmentId: fragId,
    pointer: null,
    by: `agent0:${MODEL}`,
  });
}

// ── 事项（全部虚构）──

// A. 数据结构课程设计（多元素 + 多证据）
const itemA = makeItem(
  "create_item",
  "从学习交流群提取：数据结构课设（图书管理系统）",
  {
    elements: [
      { label: "name", text: "数据结构课程设计（图书管理系统）", note: null },
      { label: "dueDate", text: "2026-10-08T23:59:59", note: null },
      {
        label: "summary",
        text: "数据结构课设：实现一个图书管理系统，提交设计文档与源码。",
        note: null,
      },
      { label: "提交物", text: "设计文档（PDF）+ 源码压缩包", note: null },
      { label: "提交平台", text: "教学网课程页", note: null },
      { label: "要求", text: "含测试用例与运行说明", note: null },
    ],
    tags: ["课程", "大作业"],
    status: "todo",
    doubtNote: null,
  },
  3 * DAY,
);
ev(itemA, "元素:name", fragFrom(0, "数据结构大作业：实现一个图书管理系统"));
ev(itemA, "元素:dueDate", fragFrom(0, "10 月 8 日前把设计文档和源码打包交到教学网"));
ev(itemA, "元素:提交平台", fragFrom(0, "交到教学网"));
ev(itemA, "元素:提交物", fragFrom(0, "设计文档和源码打包"));

// G. 图书馆还书（未读 → 看板显示「新」）
const itemG = makeItem(
  "create_item",
  "从班级通知群提取：图书馆还书提醒",
  {
    elements: [
      { label: "name", text: "归还《算法导论》（图书馆）", note: null },
      { label: "dueDate", text: "2026-10-05T23:59:59", note: null },
      {
        label: "summary",
        text: "图书馆借的《算法导论》10 月 5 日到期，记得续借或归还。",
        note: null,
      },
      { label: "馆藏地", text: "北区图书馆三层", note: null },
    ],
    tags: ["事务"],
    status: "todo",
    doubtNote: null,
  },
  1 * DAY,
);
ev(itemG, "元素:dueDate", fragFrom(1, "应还日期为 10 月 5 日"));

// C. 高数期中考试（推断日期带 note）
const itemC = makeItem(
  "create_item",
  "从学习交流群提取：高数期中考试安排",
  {
    elements: [
      { label: "name", text: "高等数学期中考试", note: null },
      { label: "dueDate", text: "2026-10-22T14:00:00", note: "第 8 周周四——按校历第 8 周推算" },
      {
        label: "summary",
        text: "高数期中考试：第 8 周周四下午，考场待通知。",
        note: null,
      },
      { label: "考场", text: "待通知（通知后更新）", note: null },
    ],
    tags: ["课程"],
    status: "todo",
    doubtNote: null,
  },
  2 * DAY,
);
ev(itemC, "元素:dueDate", fragFrom(2, "定于第 8 周周四下午 14:00–16:00"));

// I. 与导师组会（来自前台对话录入）
const itemI = makeItem(
  "create_item",
  "从前台对话录入：与导师组会",
  {
    elements: [
      { label: "name", text: "与导师开组会讨论毕设选题", note: null },
      {
        label: "dueDate",
        text: "2026-10-01T14:00:00",
        note: "用户口述「10 月 1 日」——下午时段未指定，按上课时段默认 14:00",
      },
      { label: "summary", text: "和导师约好 10 月 1 日讨论毕设选题方向。", note: null },
      { label: "地点", text: "信电楼 302（导师办公室）", note: null },
    ],
    tags: ["学业"],
    status: "todo",
    doubtNote: null,
  },
  30 * 60_000,
);
ev(itemI, "元素:name", fragFrom(7, "10 月 1 日要和导师开组会讨论选题"));

// D. 校医院体检复查（无日期）
const itemD = makeItem(
  "create_item",
  "从班级通知群提取：体检复查提醒",
  {
    elements: [
      { label: "name", text: "到校医院做入学体检复查", note: null },
      {
        label: "summary",
        text: "入学体检有两项需要复查，带上学生卡去校医院登记。",
        note: null,
      },
      { label: "地点", text: "校医院二楼", note: null },
      { label: "材料", text: "学生卡", note: null },
    ],
    tags: ["事务"],
    status: "todo",
    doubtNote: null,
  },
  5 * DAY,
);
ev(itemD, "元素:name", fragFrom(3, "请携带学生卡到校医院二楼登记复查"));

// H. 程序设计竞赛报名（无日期）
const itemH = makeItem(
  "create_item",
  "从社团大群提取：校赛报名",
  {
    elements: [
      { label: "name", text: "报名参加程序设计竞赛（校赛）", note: null },
      {
        label: "summary",
        text: "校程序设计竞赛开始报名：三人一队，先在竞赛平台组队。",
        note: null,
      },
      { label: "报名入口", text: "竞赛平台（组队后报名）", note: null },
      { label: "组队要求", text: "3 人一队", note: null },
    ],
    tags: ["社团", "竞赛"],
    status: "todo",
    doubtNote: null,
  },
  4 * DAY,
);
ev(itemH, "元素:组队要求", fragFrom(4, "三人一队，先到竞赛平台组队再报名"));

// E. 课程论文（已完成——两个版本：建 + 完成）
const itemE = makeItem(
  "create_item",
  "从班级通知群提取：《形势与政策》论文",
  {
    elements: [
      { label: "name", text: "提交《形势与政策》课程论文", note: null },
      { label: "dueDate", text: wallClockAgo(6 * DAY).slice(0, 10) + "T23:59:59", note: null },
      { label: "summary", text: "形势与政策课程论文：3000 字、主题自选。", note: null },
      { label: "提交方式", text: "课程群作业", note: null },
    ],
    tags: ["课程"],
    status: "todo",
    doubtNote: null,
  },
  6 * DAY,
);
ev(itemE, "元素:name", fragFrom(5, "《形势与政策》论文"));
{
  const done = repo.appendItemVersion(db, {
    itemId: itemE,
    action: "complete_item",
    detail: "用户点完成：论文已交",
    snapshot: {
      elements: [
        { label: "name", text: "提交《形势与政策》课程论文", note: null },
        { label: "dueDate", text: wallClockAgo(6 * DAY).slice(0, 10) + "T23:59:59", note: null },
        { label: "summary", text: "形势与政策课程论文：3000 字、主题自选。", note: null },
        { label: "提交方式", text: "课程群作业", note: null },
      ],
      tags: ["课程"],
      status: "done",
      doubtNote: null,
    },
    by: { actor: "用户", model: null },
  });
  client
    .prepare("UPDATE item_versions SET at = ? WHERE id = ?")
    .run(wallClockAgo(2 * HOUR), done.id);
}

// F. 社团值班（完成 → 归档——三个版本）
const itemF = makeItem(
  "create_item",
  "从社团大群提取：招新值班",
  {
    elements: [
      { label: "name", text: "社团招新摊位值班（周六上午）", note: null },
      { label: "summary", text: "周六上午在招新摊位值班。", note: null },
      { label: "地点", text: "东区操场 A12 摊位", note: null },
    ],
    tags: ["社团"],
    status: "todo",
    doubtNote: null,
  },
  9 * DAY,
);
ev(itemF, "元素:name", fragFrom(6, "本周六招新摊位值班"));
{
  const done = repo.appendItemVersion(db, {
    itemId: itemF,
    action: "complete_item",
    detail: "用户点完成：值班结束",
    snapshot: {
      elements: [
        { label: "name", text: "社团招新摊位值班（周六上午）", note: null },
        { label: "summary", text: "周六上午在招新摊位值班。", note: null },
        { label: "地点", text: "东区操场 A12 摊位", note: null },
      ],
      tags: ["社团"],
      status: "done",
      doubtNote: null,
    },
    by: { actor: "用户", model: null },
  });
  client
    .prepare("UPDATE item_versions SET at = ? WHERE id = ?")
    .run(wallClockAgo(4 * DAY), done.id);

  const arch = repo.appendItemVersion(db, {
    itemId: itemF,
    action: "archive_item",
    detail: "用户点归档：旧事清出待办",
    snapshot: {
      elements: [
        { label: "name", text: "社团招新摊位值班（周六上午）", note: null },
        { label: "summary", text: "周六上午在招新摊位值班。", note: null },
        { label: "地点", text: "东区操场 A12 摊位", note: null },
      ],
      tags: ["社团"],
      status: "archived",
      doubtNote: null,
    },
    by: { actor: "用户", model: null },
  });
  client
    .prepare("UPDATE item_versions SET at = ? WHERE id = ?")
    .run(wallClockAgo(3 * DAY), arch.id);
}

// ── 已读标记：「新」微标只留给 G（图书馆还书）──
for (const id of [itemA, itemC, itemI, itemD, itemH, itemE, itemF]) {
  repo.markItemViewed(db, id);
}

// ── 存疑信息库（2 条）──
repo.insertUncertainInput(db, {
  content: "有人说下周可能要体测，具体哪天还没通知。",
  sourceType: "nc",
  sourceIdentity: { sourceLabel: "社团大群", groupId: "10003", sender: "阿凯" },
  eventTime: null,
  receivedAt: wallClockAgo(2 * DAY),
  originRawInputId: null,
  needsHuman: 60,
  reason: "体测时间说法含糊、来源为同学闲聊转述，无法确认",
  createdAt: wallClockAgo(2 * DAY),
});
repo.insertUncertainInput(db, {
  content: "听说三食堂下个月要停业装修，不知道具体从哪天开始。",
  sourceType: "nc",
  sourceIdentity: { sourceLabel: "学习交流群", groupId: "10001", sender: "小林" },
  eventTime: null,
  receivedAt: wallClockAgo(1 * DAY),
  originRawInputId: null,
  needsHuman: 45,
  reason: "来源为「听说」、无官方通知；停业时间不明",
  createdAt: wallClockAgo(1 * DAY),
});

// ── 对话（4 轮）──
const turns: { role: "user" | "assistant"; content: string; atAgo: number }[] = [
  {
    role: "user",
    content: "这周有什么要交的东西吗？",
    atAgo: 40 * 60_000,
  },
  {
    role: "assistant",
    content:
      "看板上有这几件：\n\n- **数据结构课设**：10 月 8 日前交设计文档和源码到教学网\n- **《算法导论》**：10 月 5 日到期，记得续借或归还\n- **高数期中**：第 8 周周四下午考试，考场还没通知",
    atAgo: 39 * 60_000,
  },
  {
    role: "user",
    content: "帮我记一下，10 月 1 日要和导师开组会讨论选题。",
    atAgo: 30 * 60_000,
  },
  {
    role: "assistant",
    content: "好，已记下：10 月 1 日与导师组会讨论毕设选题——稍后会出现在看板上。",
    atAgo: 29 * 60_000,
  },
];
for (const t of turns) {
  repo.appendChatTurn(db, t.role, t.content);
  client
    .prepare("UPDATE chat_turns SET at = ? WHERE rowid = (SELECT MAX(rowid) FROM chat_turns)")
    .run(wallClockAgo(t.atAgo));
}

// ── 信源设置（nc 的演示白名单）──
// `__schema__`：信源声明的设置项——与 registerSources 落库同源（从适配器声明直接取，永不失步）。
const declared = SettingFieldSchema.array().parse(makeNcAdapter().settings?.() ?? []);
repo.setSourceSetting(db, "nc", "__schema__", JSON.stringify(declared));
repo.setSourceSetting(
  db,
  "nc",
  "groups",
  JSON.stringify({ "10001": "学习交流群", "10002": "班级通知群", "10003": "社团大群" }),
);
repo.setSourceSetting(db, "nc", "windowMinutes", JSON.stringify(3));

// ── 演示用 AI 配置（**虚构**——公开截图用；真实使用请在设置面板改回你的接入）──
repo.setAppSetting(
  db,
  "ai",
  JSON.stringify({
    baseUrl: "https://api.example.com/v1",
    model: "demo-model",
    apiKey: "sk-demo-1234",
  }),
);

db.$client.close();
console.log("演示数据已写入：8 事项 / 8 批次 / 2 存疑 / 4 轮对话 / nc 设置 + 虚构 AI 配置");
