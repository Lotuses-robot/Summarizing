import { describe, expect, it } from "vitest";
import { MAX_TOKENS_CHARS, tokenizeContent, tokenizeIdentity } from "../search/tokenize";

// 切词（D-127）：索引侧与查询侧走**同一个函数**——两套切法必然对不上（一边切一边不切），
// 所以这里断言的是「查询词本身切出来的 token 能在索引 token 里找到」，而不是固定字符串。

/** token 串 → token 集合（切词产出空格分隔的词）。 */
function tokens(s: string): string[] {
  return s.split(" ").filter((t) => t !== "");
}

describe("内容切词", () => {
  it("图片占位的 URL 不进词袋（只留「图片」这个事实）", () => {
    const out = tokenizeContent("[图片](https://multimedia.n.qq.com.cn/download?rkey=abc123)");
    expect(out).toContain("图片");
    expect(out).not.toContain("rkey");
    expect(out).not.toContain("multimedia");
    expect(out).not.toContain("abc123");
  });

  it("图片占位被整体替换（URL 不再是 token 的一部分）", () => {
    const out = tokenizeContent("[图片](https://example.com/a/b.png) 闭馆通知");
    expect(out).toContain("闭馆");
    expect(out).not.toContain("example");
    expect(out).not.toContain("png");
  });

  it("二字词（高数/课群）完整成词——jieba 切碎后仍能召回", () => {
    // jieba 把「高数」切成 高/数、把「英语课群」切成 英语/英语课/群
    // 二元组保证「高数」「课群」原样成词，否则这两个查询搜不到任何东西
    expect(tokens(tokenizeContent("高数"))).toContain("高数");
    expect(tokens(tokenizeContent("英语课群"))).toContain("课群");
  });

  it("多字词整体成词（图书馆）", () => {
    expect(tokens(tokenizeContent("图书馆通知"))).toContain("图书馆");
  });

  it("拉丁/数字串整段保留（不拆成单个数字）", () => {
    expect(tokens(tokenizeContent("groupId 10001"))).toContain("10001");
    expect(tokens(tokenizeContent("groupId 10001"))).toContain("groupId");
  });

  it("标点/控制字符被剔除", () => {
    const out = tokenizeContent("通知！！！\u0000闭馆……");
    expect(out).not.toContain("！");
    expect(out).not.toContain("…");
    expect(tokens(out)).toContain("闭馆");
  });

  it("全是非索引字符 → 空串（不是错误）", () => {
    expect(tokenizeContent("！！！")).toBe("");
    expect(tokenizeContent("")).toBe("");
  });

  it("超长正文截断到上限", () => {
    const long = "闭馆通知".repeat(20_000);
    expect(tokenizeContent(long).length).toBeLessThanOrEqual(MAX_TOKENS_CHARS);
  });
});

describe("身份词袋", () => {
  it("键名与值都在袋里（形状无关）", () => {
    const out = tokenizeIdentity({
      displayName: "英语课群",
      groupId: "10001",
      sender: "图书馆",
    });
    expect(tokens(out)).toContain("displayName");
    expect(tokens(out)).toContain("groupId");
    expect(tokens(out)).toContain("sender");
    expect(tokens(out)).toContain("10001");
    expect(tokens(out)).toContain("图书馆");
    // 多字值本身不一定整词成 token（jieba 会切 + 二元组是 2 字），
    // 但「搜这个词」要能命中——见下方「部分匹配」与「索引侧与查询侧同源」。
    const query = tokens(tokenizeContent("英语课群"));
    expect(query.some((t) => tokens(out).includes(t))).toBe(true);
  });

  it("部分匹配可用：搜「课群」命中「英语课群」", () => {
    const indexed = tokenizeIdentity({ displayName: "英语课群" });
    const query = tokenizeContent("课群");
    // 查询侧的「课群」必须是索引侧已有的 token（否则 MATCH 落空）
    expect(tokens(query).some((t) => tokens(indexed).includes(t))).toBe(true);
  });

  it("非字符串的值（数字/布尔）也进袋", () => {
    const out = tokenizeIdentity({ displayName: "群", count: 42, official: true });
    expect(tokens(out)).toContain("42");
    expect(tokens(out)).toContain("true");
  });

  it("空身份 → 空串", () => {
    expect(tokenizeIdentity({})).toBe("");
  });
});

describe("索引侧与查询侧同源", () => {
  it("查询词的 token 全部出现在同词索引里（自洽）", () => {
    const words = ["高数", "课群", "英语课群", "图书馆", "闭馆", "通知", "10001"];
    for (const w of words) {
      const indexed = tokens(tokenizeContent(w));
      const query = tokens(tokenizeContent(w));
      for (const t of query) {
        expect(indexed).toContain(t);
      }
    }
  });
});
