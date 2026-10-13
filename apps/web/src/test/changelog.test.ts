// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../lib/changelog";
// CHANGELOG 解析（更新日志弹窗的数据源）：版本段切分 + [未发布]/非版本标题跳过 + 边界形态。

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

  it("rc/预发布后缀不截断（`[v0.2.0-rc.1]` 是完整版本号）", () => {
    const md = ["## [v0.2.0-rc.1]", "候选正文"].join("\n");
    const versions = parseChangelog(md);
    expect(versions.map((v) => v.version)).toEqual(["v0.2.0-rc.1"]);
    expect(versions[0]?.body).toContain("候选正文");
  });

  it("方括号后跟文字（无破折号）也认（`[v0.3.0] 补丁说明`）", () => {
    const md = ["## [v0.3.0] 补丁说明", "正文"].join("\n");
    const versions = parseChangelog(md);
    expect(versions.map((v) => v.version)).toEqual(["v0.3.0"]);
    expect(versions[0]?.body).toContain("正文");
  });

  it("非版本二级标题（附录/关于）不产出版本段", () => {
    const md = ["## [v0.3.0]", "正文", "", "## 附录", "附文"].join("\n");
    const versions = parseChangelog(md);
    expect(versions.map((v) => v.version)).toEqual(["v0.3.0"]);
    expect(versions[0]?.body).not.toContain("附文"); // 附录不进上一段
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

  it("真 CHANGELOG.md（?raw 导入）能解析出至少一个版本，且不全同名（守集成）", async () => {
    const raw = (await import("../../../../CHANGELOG.md?raw")).default;
    const versions = parseChangelog(raw);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]?.version.startsWith("v")).toBe(true);
    // 无截断/重名（rc 截断事故的守门：版本号两两不同）
    const names = versions.map((v) => v.version);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("shouldShowChangelog 弹窗判断（localStorage 已读记忆）", () => {
  // happy-dom 的 localStorage 同文件共享——用例间清空
  /** 清空本机已读记忆（用例隔离）。 */
  const reset = () => window.localStorage.clear();

  it("从未记过（新设备）→ 弹（首发版 v0.3.0 要能被存量/新装设备看到一次）", async () => {
    reset();
    const { shouldShowChangelog } = await import("../components/AboutModal");
    expect(shouldShowChangelog()).toBe(true);
    // 纯判断不写状态——只有 markChangelogSeen 才落记忆
    expect(window.localStorage.getItem("summarizing.seenVersion")).toBeNull();
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

  it("lastSeenVersion 给「旧 → 新」chip 提供旧版本号（未记过 → null）", async () => {
    reset();
    const { lastSeenVersion } = await import("../components/AboutModal");
    expect(lastSeenVersion()).toBeNull(); // 未记过
    window.localStorage.setItem("summarizing.seenVersion", "v0.2.0");
    expect(lastSeenVersion()).toBe("v0.2.0"); // 更新场景渲染「v0.2.0 → 当前版」
  });
});
