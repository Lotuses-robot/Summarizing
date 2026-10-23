import { describe, expect, it } from "vitest";
import { buildDigestPrompt } from "../agent0/prompt";

// 用户拒收规则进提示词（D-107）：硬闸 + 前置 + 只拒点名不外推 + 最高优先。
// 断言的是**提示词文本上的可验证性质**（规则在场、位置在【准入】前、约束语在场）——
// 模型是否照做属理解质量，不在围栏机械判据内（01§4.10）。

describe("buildDigestPrompt：用户拒收规则注入（D-107）", () => {
  it("未设置 → 明示「用户未设置任何拒收规则」，不留空块", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("（用户未设置任何拒收规则）");
    expect(p).toContain("【用户拒收规则");
  });

  it("规则原文原样在场（不摘要、不结构化——用户自由文本）", () => {
    const rules = "不要拼多多砍一刀类链接；早安图不要收。";
    const p = buildDigestPrompt(rules);
    expect(p).toContain(rules);
  });

  it("硬闸前置：规则块在【准入】之前（优先于任何「倾向建」取向）", () => {
    const p = buildDigestPrompt("测试规则");
    const ruleAt = p.indexOf("【用户拒收规则");
    const admitAt = p.indexOf("【准入");
    expect(ruleAt).toBeGreaterThanOrEqual(0);
    expect(admitAt).toBeGreaterThan(ruleAt); // 规则在准入之前
  });

  it("三条约束语都在：命中即拒三类 / 只拒点名不外推 / 优先于倾向建", () => {
    const p = buildDigestPrompt("x");
    expect(p).toContain("一律不建事项、不建通知、也不进存疑库");
    expect(p).toContain("绝不外推");
    expect(p).toContain("优先于本提示词其余任何");
  });

  it("损失审计是双向的：既问「漏了可惜」也问「这也要记」", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("若不建");
    expect(p).toContain("若建");
    expect(p).toContain("这么重要的东西你居然漏了");
    expect(p).toContain("这也要记");
  });

  it("判「不建」必须留痕（不许静默输出空清单）", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("必须用 record_note 留一句理由");
  });

  it("通知的结构红线仍在：不得含 dueDate", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain('kind:"notice"');
    expect(p).toContain("不得含 dueDate");
  });
});

describe("buildDigestPrompt：检索面与矛盾决断（D-127）", () => {
  it("检索面用 search_raws，并讲清并/交与截断标注", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("search_raws");
    expect(p).not.toContain("search_recent_raws");
    expect(p).toContain("mode=all");
    expect(p).toContain("mode=any");
    expect(p).toContain("truncated");
    expect(p).toContain("contentLength");
    // 截断的含义要说清，且**指路到 get_raw**（而不是教模型换关键词碰运气——
    // 那正是 get_raw 存在要取代的做法）
    expect(p).toContain("get_raw");
    expect(p).toContain("取完整原文");
    expect(p).not.toContain("缩小范围再查");
  });

  it("信源说明：wecom 是「客户咨询企业」，不是用户自己的待办", () => {
    // 用户 2026-10-23：「调整一下对 agent0 消化的提示词，至少现在先暂时手动加进去对 wecom 的了解，
    // 不然他还以为这是什么信息」——此前提示词里只有 chat/nc 的隐含假设。
    const p = buildDigestPrompt("");
    expect(p).toContain("【信源说明");
    expect(p).toContain("wecom");
    expect(p).toContain("企业微信");
    expect(p).toContain("不是用户本人的待办");
    expect(p).toContain("chat");
    expect(p).toContain("nc");
  });

  it("矛盾决断：无权威性字段时不得凭猜测决断", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("实际存在的字段");
    expect(p).toContain("不得凭「群名听起来更官方」");
    // 旧的「官方群 > 班级群 > 个人转述」要求 AI 去比一个数据里没有的属性，已删
    expect(p).not.toContain("官方群 > 班级群 > 个人转述");
    expect(p).not.toContain("署名发信人 > 匿名");
  });
});

describe("buildDigestPrompt：事项 / 通知判类（2026-10-21 走查修订）", () => {
  it("主尺 = 备忘录测试（不用动作词清单判类）", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("如果这条消息是你自己记在手机备忘录里的，你会把它写成待办吗");
    // 旧的「作业、会议、报名、投票…」清单已删——词面命中曾把一条报名公告误建为事项
    expect(p).not.toContain("（作业、会议、报名、投票、领取、缴费、登记、面试、提交…）");
    expect(p).toContain("不要靠关键词命中判类");
  });

  it("条件受众：面向「参加 X 的同学」这类群体时倾向通知；带时间压力才判事项", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("条件群体");
    expect(p).toContain("不替他承担可能的义务");
    expect(p).toContain("带明确时间压力");
  });

  it("重要性测试兜漏判：无比重要 → 破例进待办", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("重要性测试");
    expect(p).toContain("无比重要");
  });

  it("缺日期/缺字段不是存疑（doubtNote 恒 null）", () => {
    const p = buildDigestPrompt("");
    expect(p).toContain("缺日期 / 缺字段不是存疑");
    expect(p).toContain("doubtNote 恒为 null");
    // 格式文档里不再给 doubtNote 留槽位（有槽位模型就会填）
    expect(p).not.toContain('"doubtNote":null');
  });
});
