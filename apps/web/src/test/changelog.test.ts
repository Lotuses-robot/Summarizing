// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../lib/changelog";
// CHANGELOG 解析（更新日志弹窗的数据源）：版本段切分 + [未发布] 跳过 + 边界形态。

describe("parseChangelog", () => {
  it("按 ## 标题切版本段；[未发布] 跳过；最新在前", () => {
    const md = [
      "# 更新日志",
      "",
      "## [未发布]",
      "",
      "（开发中）",
      "",
      "## [v0.3.0] - 2026-10-13",
      "",
      "- 特性 A",
      "",
      "## [v0.2.0] - 2026-10-12",
      "",
      "- 特性 B",
    ].join("\n");
    const versions = parseChangelog(md);
    expect(versions.map((v) => v.version)).toEqual(["v0.3.0", "v0.2.0"]);
    expect(versions[0]?.body).toContain("特性 A");
    expect(versions[1]?.body).toContain("特性 B");
  });

  it("标题变体兼容：无方括号 / 无日期 / 破折号", () => {
    const md = ["## v0.3.0", "正文1", "## [v0.2.0] — 某日", "正文2"].join("\n");
    const versions = parseChangelog(md);
    expect(versions.map((v) => v.version)).toEqual(["v0.3.0", "v0.2.0"]);
    expect(versions[1]?.body).toContain("正文2");
  });

  it("### 三级标题不算版本段（并入上一段正文）", () => {
    const md = ["## [v0.3.0]", "### 子标题", "正文"].join("\n");
    const versions = parseChangelog(md);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.body).toContain("### 子标题");
  });

  it("只有 [未发布] → 空数组", () => {
    expect(parseChangelog("# 更新日志\n\n## [未发布]\n\n草稿")).toEqual([]);
  });

  it("真 CHANGELOG.md（?raw 导入）能解析出至少一个版本（守集成）", async () => {
    const raw = (await import("../../../../CHANGELOG.md?raw")).default;
    const versions = parseChangelog(raw);
    expect(versions.length).toBeGreaterThan(0);
    // 版本号以 v 开头（真实版本，非未发布）
    expect(versions[0]?.version.startsWith("v")).toBe(true);
  });
});

describe("shouldShowChangelog 弹窗判断（localStorage 已读记忆）", () => {
  // happy-dom 的 localStorage 同文件共享——用例间清空
  /** 清空本机已读记忆（用例隔离）。 */
  const reset = () => window.localStorage.clear();

  it("首次安装（无记录）→ 不弹，并记下当前版", async () => {
    reset();
    const { shouldShowChangelog } = await import("../components/AboutModal");
    expect(shouldShowChangelog()).toBe(false);
    expect(window.localStorage.getItem("summarizing.seenVersion")).not.toBeNull();
  });

  it("已读过当前版 → 不弹", async () => {
    reset();
    const { markChangelogSeen, shouldShowChangelog } = await import("../components/AboutModal");
    markChangelogSeen();
    expect(shouldShowChangelog()).toBe(false);
  });

  it("记的是旧版 → 弹（新版本来了）", async () => {
    reset();
    const { shouldShowChangelog } = await import("../components/AboutModal");
    window.localStorage.setItem("summarizing.seenVersion", "v0.0.1-远古");
    expect(shouldShowChangelog()).toBe(true);
  });
});
