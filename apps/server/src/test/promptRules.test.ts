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
