import type { ReactNode } from "react";

// 前台回复的 Markdown 子集渲染（用户 2026-09-30 插播：回复要有样式 + 多行正确显示）。
// 刻意不引 markdown 库（D-81 无黑盒依赖精神）：只支持模型实际会吐的子集——
// 段落/换行/无序列表/有序列表/标题/粗体/行内代码/链接；**不渲染任何原始 HTML**（React 文本节点天然转义），
// 链接只放行 http(s)/mailto（防 javascript: 注入）。超集需求出现时再提案升级。
// 拆家触发条件（simplify 高度评审）：出现第二消费方（如看板说明渲染）或需跨包复用解析时，
// 拆 lib/markdown.ts（解析）+ components/Markdown.tsx（渲染）——本次不拆（React 同 bundle，无现实代价）。

type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

type Block =
  | { kind: "p"; text: string } // 段内换行由 whitespace-pre-wrap 保真
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "h"; text: string };

/** 行内解析：**粗体** / `代码` / [文本](链接)——按出现顺序切成 token（无嵌套）。
 *  链接白名单内联在正则里（仅 http(s)/mailto 才成 token；其余按纯文本，防 javascript: 注入）。 */
function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index;
    if (idx === undefined) continue;
    if (idx > last) out.push({ kind: "text", text: text.slice(last, idx) });
    const [full, bold, code, linkText, linkUrl] = m;
    if (bold !== undefined) out.push({ kind: "bold", text: bold });
    else if (code !== undefined) out.push({ kind: "code", text: code });
    else if (linkText !== undefined && linkUrl !== undefined)
      out.push({ kind: "link", text: linkText, href: linkUrl });
    last = idx + full.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** 块级解析：空行分段；识别标题 / 无序列表（- 或 *）/ 有序列表（1. 1)）；其余并入段落。 */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  /** 收束当前段落/列表（遇到换类块或空行时调用）。 */
  const flush = () => {
    if (para.length > 0) {
      blocks.push({ kind: "p", text: para.join("\n") });
      para = [];
    }
    if (list !== null) {
      blocks.push(list);
      list = null;
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h !== null) {
      flush();
      blocks.push({ kind: "h", text: h[1] ?? "" });
    } else if (ul !== null || ol !== null) {
      // ul/ol 合并一支（simplify 评审：两分支同构）；「切类列表才 flush」蕴含「段落已收」
      const kind = ul !== null ? "ul" : "ol";
      if (list === null || list.kind !== kind) {
        flush();
        list = { kind, items: [] };
      }
      list.items.push((ul ?? ol)?.[1] ?? "");
    } else {
      // 列表项的续行（缩进的非空行）并入上一条，不另起段落——模型常这么写明细
      if (list !== null && /^\s+\S/.test(line) && list.items.length > 0) {
        const last = list.items.length - 1;
        list.items[last] = `${list.items[last] ?? ""}\n${line.trim()}`;
        continue;
      }
      if (list !== null) flush();
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** 行内 token → React 节点（纯文本节点渲染，无 dangerouslySetInnerHTML）。 */
function inlineNodes(tokens: Inline[]): ReactNode {
  return tokens.map((t, i) => {
    if (t.kind === "bold") return <strong key={i}>{t.text}</strong>;
    if (t.kind === "code")
      return (
        <code key={i} className="rounded bg-surface px-1 py-0.5 text-[0.85em]">
          {t.text}
        </code>
      );
    if (t.kind === "link")
      return (
        <a
          key={i}
          className="text-accent hover:underline"
          href={t.href}
          target="_blank"
          rel="noreferrer"
        >
          {t.text}
        </a>
      );
    return <span key={i}>{t.text}</span>;
  });
}

/** Markdown 子集渲染：段落保真换行（pre-wrap）、列表、标题、粗体/代码/链接。
 *  用户气泡不走这里（用户的话按纯文本 + pre-wrap 展示——粘贴的星号就是星号）。 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) => {
        if (b.kind === "h")
          return (
            <p key={i} className="font-semibold">
              {inlineNodes(parseInline(b.text))}
            </p>
          );
        if (b.kind === "ul")
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {b.items.map((it, j) => (
                <li key={j} className="whitespace-pre-wrap">
                  {inlineNodes(parseInline(it))}
                </li>
              ))}
            </ul>
          );
        if (b.kind === "ol")
          return (
            <ol key={i} className="list-decimal space-y-0.5 pl-5">
              {b.items.map((it, j) => (
                <li key={j} className="whitespace-pre-wrap">
                  {inlineNodes(parseInline(it))}
                </li>
              ))}
            </ol>
          );
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inlineNodes(parseInline(b.text))}
          </p>
        );
      })}
    </div>
  );
}
