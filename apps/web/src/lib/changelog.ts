// CHANGELOG 解析（更新日志弹窗用）：CHANGELOG.md 是**唯一出处**——不引入 package.json version、
// 不做后端接口。构建时经 vite `?raw` 打包进前端，零网络请求。
// 只解析「## [版本] ...」为界的版本段；`## [未发布]` 不算版本（开发中的草稿，不该弹给用户）。

/** 一个版本段（版本号 + 该段正文 Markdown）。 */
export interface ChangelogVersion {
  version: string; // 如 "v0.3.0"（不含方括号）
  body: string; // 该版本标题行之后的正文（Markdown 源，交给既有 Markdown 组件渲染）
}

/** 版本标题行：`## [v0.3.0] - 2026-10-13` / `## [v0.3.0] 补丁说明` / `## v0.3.0`。
 *  方括号内 = 完整标题（含 rc/beta 后缀，不截断）；无方括号 = 行内首 token。 */
function parseVersionHeading(line: string): string | null {
  const bracketed = /^##\s+\[([^\]]+)\]/.exec(line);
  const raw = bracketed !== null ? bracketed[1] : /^##\s+(\S+)/.exec(line)?.[1];
  const v = raw?.trim() ?? "";
  // 只认版本号（本项目 tag 一律 v*）：排除 [未发布] 与普通章节（## 附录 等不产出版本段）
  return /^v\d/.test(v) ? v : null;
}

/** 解析整个 CHANGELOG：按出现顺序返回版本段（最新在上，与文件同序）。`[未发布]`/非版本标题跳过。 */
export function parseChangelog(md: string): ChangelogVersion[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: ChangelogVersion[] = [];
  let current: { version: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    // 只认二级标题（## 且非 ###）；顶层 "# 更新日志" 不算
    if (/^##\s/.test(line) && !/^###/.test(line)) {
      if (current !== null)
        out.push({ version: current.version, body: current.bodyLines.join("\n").trim() });
      const version = parseVersionHeading(line);
      // 非版本标题（[未发布]/附录等）→ 关闭当前段、不产出新段
      current = version === null ? null : { version, bodyLines: [] };
      continue;
    }
    if (current !== null) current.bodyLines.push(line);
  }
  if (current !== null)
    out.push({ version: current.version, body: current.bodyLines.join("\n").trim() });
  return out;
}
