import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Locate, X } from "lucide-react";
import {
  CHAT_HISTORY_ITEM_MAX_CHARS,
  CHAT_HISTORY_MAX_ITEMS,
  type ChatHistoryItem,
  type ChatResponse,
} from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";
import { pushEscLayer } from "../../lib/escLayer";
import { Markdown } from "../../lib/markdown";
import { isNearBottom } from "../../lib/scrollAnchor";

type Msg = {
  role: "user" | "front";
  text: string; // 用户看到的纯文本（不含 @ 注记——那是随请求上传的元数据）
  local?: boolean; // local = 本地占位（如错误提示），不进 history
  res?: ChatResponse; // 前台回复附带的工具轨迹 / 事项 chips（05§四）
};

type Mention = { id: string; title: string };

/** 对话面板（05§四）：VS Code 停靠式——只听用户的，绝不自动收；
 *  会话流 + 工具轨迹 chips（人话）+ 事项 chips（点击深链看板）+ @ 提及事项（2026-09-27）。 */
export function ChatPanel({
  items,
  onActivity,
  onRequestFocus,
  onClose,
}: {
  items: Mention[]; // 看板事项（@ 候选）
  onActivity: () => void;
  onRequestFocus: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // 非 null = @ 模式（值 = @ 后文本）
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 滚动锚定（specs/001）：容器 ref + 「是否跟随最新」开关。
  // 初始真——打开/回填即看最新；用户上翻离开底部后由 onScroll 翻假（FR-003），滚回底部再翻回真。
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  /** onScroll：按当前位置刷新「是否跟随最新」（近底容差内视为仍在底，specs/001 FR-003）。 */
  const syncStick = (): void => {
    const el = logRef.current;
    if (el === null) return;
    stickRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  };

  // 消息集变化后：仍在底部（或刚发送）→ 钉到最新；用户上翻浏览则不打扰（specs/001 US3）。
  useEffect(() => {
    const el = logRef.current;
    if (el === null || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // 面板与 @ 下拉各挂一层 Esc（05§六）：后注册先退——下拉关完才轮到收面板
  useEffect(() => pushEscLayer(() => onCloseRef.current()), []);
  useEffect(() => {
    if (mentionQuery === null) return;
    return pushEscLayer(() => setMentionQuery(null));
  }, [mentionQuery]);

  // 启动回填（D-89）：拉最近历史 → 纯文本气泡（工具轨迹/事项 chips 不回填，L20）。
  // 仅当本地还没产生消息时落地——防与「打开面板后立刻发消息」竞态覆盖。
  useEffect(() => {
    let alive = true;
    api
      .chatHistory()
      .then((res) => {
        if (!alive) return;
        setMsgs((cur) =>
          cur.length > 0
            ? cur
            : res.turns.map((t) => ({
                role: t.role === "user" ? ("user" as const) : ("front" as const),
                text: t.content,
              })),
        );
      })
      .catch(() => {
        // 降级可见（不静默）：一行本地占位，不进 history
        if (!alive) return;
        setMsgs((cur) =>
          cur.length > 0
            ? cur
            : [{ role: "front", text: "（历史记录暂时拉不回来，不影响继续对话）", local: true }],
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  const matchingItems =
    mentionQuery === null
      ? []
      : items
          .filter((it) => it.title.includes(mentionQuery) || it.id.includes(mentionQuery))
          .slice(0, 6);

  /** 输入变更：光标处恰为「@片段」结尾 → 进入提及模式。 */
  const onInputChange = (v: string) => {
    setDraft(v);
    const m = /@([^\s@]*)$/.exec(v);
    setMentionQuery(m === null ? null : (m[1] ?? ""));
    setMentionHighlight(0);
  };

  /** 确认一个提及：@片段替换为「@标题 」，记录 mention（去重）。 */
  const addMention = (it: Mention) => {
    setDraft((cur) => cur.replace(/@([^\s@]*)$/, `@${it.title} `));
    setMentions((cur) => (cur.some((m) => m.id === it.id) ? cur : [...cur, it]));
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  /** 移除一个提及 chip（消息里已插入的 @标题 文本保留，但不随 mentions 上传）。 */
  const removeMention = (id: string) => {
    setMentions((cur) => cur.filter((m) => m.id !== id));
  };

  /** 发送：history = 本条之前的轮次（不含本条，剔除本地占位，截断策略与共享常量一致）；
   *  mentions 随请求上传；回复后无条件刷看板（延迟双刷等异步消化浮出）。 */
  const send = () => {
    const message = draft.trim();
    if (message === "" || busy) return;
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: message }]);
    stickRef.current = true; // 发送是用户主动作——无条件回到最新（specs/001 FR-001，哪怕之前上翻）
    // 同步快照滚底（不赖 effect）：发送后迟到的惯性 scroll 事件会把 stick 翻回 false 并跳过 effect（四轮评审竞态）
    const logEl = logRef.current;
    if (logEl !== null) logEl.scrollTop = logEl.scrollHeight;
    setDraft("");
    const savedMentions = mentions;
    setMentions([]);
    const history: ChatHistoryItem[] = msgs
      .filter((m) => !m.local)
      .slice(-CHAT_HISTORY_MAX_ITEMS)
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text.slice(0, CHAT_HISTORY_ITEM_MAX_CHARS),
      }));
    api
      .chat(message, history, mentions.slice(0, 8))
      .then((res) => {
        setMsgs((m) => [...m, { role: "front", text: res.reply, res }]);
        onActivity();
        // agent0 消化是异步的，多刷几次让结果逐步浮出来
        window.setTimeout(onActivity, 4000);
        window.setTimeout(onActivity, 10000);
      })
      .catch(() => {
        // 失败占位打 local 标记（不污染 history）；原话与提及都退回，改一字即可重发
        setDraft((cur) => (cur === "" ? message : cur)); // 等待期间用户已输入新内容则不覆盖
        setMentions(savedMentions);
        setMsgs((m) => [
          ...m,
          { role: "front", text: "（前台暂时联系不上，稍后再试）", local: true },
        ]);
      })
      .finally(() => setBusy(false));
  };

  /** 输入框按键：@ 模式 ↑↓/Enter/Esc 优先；否则 Enter 发送。 */
  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // IME 组合态（拼音确认 Enter）不当作发送/选词
    if (mentionQuery !== null) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (matchingItems.length > 0) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setMentionHighlight((h) => (h + delta + matchingItems.length) % matchingItems.length);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const picked = matchingItems[mentionHighlight];
        if (picked !== undefined) addMention(picked);
        else setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2 lg:hidden">
        <span className="text-sm font-semibold">对话</span>
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </div>
      <div
        ref={logRef}
        className="flex-1 space-y-2 overflow-y-auto p-3 text-sm"
        data-chat-log
        onScroll={syncStick}
      >
        {msgs.length === 0 && (
          <p className="text-xs text-ink-muted">
            对前台说话：提问、丢资料、补充信息都行（@ 可提及看板事项）——它自己判断怎么处理。
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i}>
            <div
              className={
                m.role === "user"
                  ? "ml-8 rounded-lg bg-accent-soft px-3 py-1.5"
                  : "mr-8 rounded-lg bg-canvas px-3 py-1.5"
              }
            >
              <span className="text-xs text-ink-muted">{m.role === "user" ? "你" : "前台"}：</span>
              {/* 前台回复渲染 Markdown 子集（2026-09-30 插播）；用户气泡纯文本 + 换行保真
                  （用户粘贴的星号就是星号，不做 markdown 解释） */}
              {m.role === "user" ? (
                <span className="whitespace-pre-wrap">{m.text}</span>
              ) : (
                <div className="mt-0.5">
                  <Markdown text={m.text} />
                </div>
              )}
            </div>
            {(m.res?.actions.length ?? 0) > 0 && (
              <div className="ml-8 mt-1 flex flex-wrap gap-1">
                {m.res?.actions.map((a, ai) => (
                  <span key={`${a.tool}-${ai}`} className="chip">
                    {a.note}
                  </span>
                ))}
              </div>
            )}
            {(m.res?.references.length ?? 0) > 0 && (
              <div className="ml-8 mt-1 flex flex-wrap gap-1">
                {m.res?.references.map((r) => (
                  <button
                    key={r.id}
                    className="chip chip-link cursor-pointer"
                    title="在看板中定位这条事项"
                    onClick={() => onRequestFocus(r.id)}
                  >
                    <Locate size={11} /> {r.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-line p-2">
        {mentions.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {mentions.map((m) => (
              <span key={m.id} className="chip chip-link">
                @ {m.title}
                <button
                  className="cursor-pointer hover:text-danger"
                  title="移除提及"
                  onClick={() => removeMention(m.id)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          <textarea
            ref={inputRef}
            className="input resize-none"
            value={draft}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="问一句，@ 提及事项，或直接丢信息…（Enter 发送，Shift+Enter 换行）"
            rows={3}
          />
          {mentionQuery !== null && matchingItems.length > 0 && (
            <ul className="absolute bottom-full left-0 z-20 mb-1 max-h-48 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg">
              {matchingItems.map((it, i) => (
                <li key={it.id}>
                  <button
                    className={cn(
                      "w-full cursor-pointer px-3 py-1 text-left text-sm",
                      i === mentionHighlight ? "bg-accent-soft text-accent" : "hover:bg-canvas",
                    )}
                    onClick={() => addMention(it)}
                  >
                    @{it.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-1 flex justify-end">
          <button className="btn btn-accent" disabled={busy || draft.trim() === ""} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </section>
  );
}
