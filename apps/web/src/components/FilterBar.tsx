import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../lib/cn";
import { pushEscLayer } from "../lib/escLayer";

/** 看板筛选状态（App 持有，FilterBar 受控——深链清筛选改这里即可）。 */
export interface BoardFilter {
  query: string; // 标题/tags 包含匹配
  tags: string[]; // 标签 token，AND 收窄
}

/** 顶部筛选栏（用户 2026-09-27 定）：整栏搜索框；输 `#` 唤起标签下拉（继续输自动匹配、
 *  ↑↓+Enter 确认、可选中尚不存在的新标签）；已选标签以 token 堆在搜索框**左侧**（点 = 移除，
 *  空框 Backspace 删末个），未选中的标签不铺开成墙；多 token = AND 收窄。 */
export function FilterBar({
  filter,
  allTags,
  onChange,
}: {
  filter: BoardFilter;
  allTags: string[];
  onChange: (next: BoardFilter) => void;
}) {
  const [tagDraft, setTagDraft] = useState<string | null>(null); // 非 null = # 模式（值 = # 后文本）
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matchingTags = tagDraft === null ? [] : allTags.filter((t) => t.includes(tagDraft));

  /** 输入变更：整体恰为「#片段」→ 进入标签选择模式。 */
  const onInputChange = (v: string) => {
    const m = /^#([^\s#]*)$/.exec(v);
    setTagDraft(m === null ? null : (m[1] ?? ""));
    setHighlight(0);
    onChange({ ...filter, query: v });
  };

  /** 确认一个标签 token（去重），清空输入退出 # 模式。 */
  const addTagToken = (name: string) => {
    const trimmed = name.trim();
    if (trimmed !== "" && !filter.tags.includes(trimmed)) {
      onChange({ ...filter, tags: [...filter.tags, trimmed], query: "" });
    }
    setTagDraft(null);
  };

  /** 搜索框按键：# 模式 ↑↓ 高亮 / Enter 确认 / Esc 只关下拉（不惊动全局 Esc 分层）；
   *  空框 Backspace 删末个 token。 */
  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (
      e.key === "Backspace" &&
      filter.query === "" &&
      tagDraft === null &&
      filter.tags.length > 0
    ) {
      onChange({ ...filter, tags: filter.tags.slice(0, -1) });
      return;
    }
    if (tagDraft === null) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (matchingTags.length > 0) {
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + delta + matchingTags.length) % matchingTags.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      // 高亮项优先；没有匹配候选就用已输片段（可选中尚不存在的新标签）
      const picked = matchingTags[highlight] ?? tagDraft ?? "";
      addTagToken(picked);
    }
  };
  // # 模式挂着「关下拉」层（05§六 分层）：无论焦点在哪，Esc 都先关下拉
  useEffect(() => {
    if (tagDraft === null) return;
    return pushEscLayer(() => setTagDraft(null));
  }, [tagDraft]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* 标签 token 嵌在输入框内部占位（用户 2026-09-27 定：不是把框挤向右，而是框内左段） */}
      <div
        className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-2 py-1.5 focus-within:border-accent"
        onClick={() => inputRef.current?.focus()}
      >
        {filter.tags.map((t) => (
          <span key={t} className="chip shrink-0 border-accent/50 text-accent">
            #{t}
            <button
              className="cursor-pointer hover:text-danger"
              title="移除该标签筛选"
              onClick={(e) => {
                e.stopPropagation();
                onChange({ ...filter, tags: filter.tags.filter((x) => x !== t) });
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="min-w-24 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
          placeholder={filter.tags.length > 0 ? "" : "过滤：标题，或 #标签"}
          value={filter.query}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        {tagDraft !== null && matchingTags.length > 0 && (
          <ul className="absolute left-0 top-full z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg">
            {matchingTags.map((t, i) => (
              <li key={t}>
                <button
                  className={cn(
                    "w-full cursor-pointer px-3 py-1 text-left text-sm",
                    i === highlight ? "bg-accent-soft text-accent" : "hover:bg-canvas",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    addTagToken(t);
                  }}
                >
                  #{t}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(filter.tags.length > 0 || filter.query.trim() !== "") && (
        <button
          className="chip shrink-0 cursor-pointer"
          title="清除全部筛选"
          onClick={() => onChange({ query: "", tags: [] })}
        >
          清除筛选
        </button>
      )}
    </div>
  );
}
