import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import { itemName, type BoardView, type UncertainInput } from "@summarizing/shared";
import { api } from "./api";
import { ActivityBar } from "./components/ActivityBar";
import { FilterBar, type BoardFilter } from "./components/FilterBar";
import { Board } from "./components/Board";
import { UncertainReview } from "./components/UncertainReview";
import { ChatPanel } from "./components/chat/ChatPanel";
import { SettingsModal } from "./components/settings/SettingsModal";
import { cn } from "./lib/cn";
import { handleEsc, pushEscLayer } from "./lib/escLayer";
import { loadChatOpen, saveChatOpen } from "./lib/appearance";

/** 全视图错误横幅（连接告警 / 存疑库过期——两条语义各有独立 state，仅标记共用）。 */
function Banner({ text }: { text: string }) {
  return (
    <div className="mx-4 mt-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
      {text}
    </div>
  );
}

/** 应用外壳（05§一 布局）：最左活动栏（主视图切换）+ 顶部整栏筛选 + 主区（看板/存疑库审核）+ 右侧停靠对话面板。
 *  录入统一走对话输入（投递条已砍）；未选标签收在筛选栏下方的「标签」栏（默认折叠）。 */
export default function App() {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [uncertain, setUncertain] = useState<UncertainInput[]>([]);
  const [view, setView] = useState<"board" | "uncertain">("board"); // 主视图切换（D-89）
  const [error, setError] = useState<string | null>(null);
  const [uncertainError, setUncertainError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // 窄屏（<1024）对话面板是全屏覆盖——首启默认收起，别让手机用户一进来就看板不可见
  const [chatOpen, setChatOpen] = useState<boolean>(
    () => window.innerWidth >= 1024 && loadChatOpen(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false); // 标签栏默认折叠（用户 2026-09-27 定）
  const [filter, setFilter] = useState<BoardFilter>({ query: "", tags: [] });
  const [focus, setFocus] = useState<{ id: string; token: number } | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);

  /** 拉看板；后端不在时挂横幅（不打断已渲染内容）。 */
  const loadBoard = useCallback(() => {
    api
      .board()
      .then((b) => {
        setBoard(b);
        setError(null); // 恢复连线就撤横幅——错误态不滞留
      })
      .catch(() => setError("后端服务未连接（apps/server 是否在跑？）"));
  }, []);

  /** 拉存疑库 open 列表（D-89）：审核页数据 + 活动栏徽标计数共用同一份。
   *  失败置可见错误（不静默——否则审核页会拿旧数据/假空态说事，评审 Critical）。 */
  const loadUncertain = useCallback(() => {
    api
      .uncertain("open")
      .then((list) => {
        setUncertain(list);
        setUncertainError(null);
      })
      .catch(() => setUncertainError("存疑库拉取失败——列表与计数可能已过期"));
  }, []);

  // 轮询看的是「当前视图」——审核页在前台时暂停拉存疑库（破坏性列表不许在读者手底下位移），
  // 看板数据照刷；离开审核页后下个周期自然恢复。用 ref 取最新视图，防 effect 重建定时器。
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view; // 渲染期不写 ref（React 约定），effect 里同步
  }, [view]);
  useEffect(() => {
    loadBoard();
    loadUncertain();
    // agent0 消化是异步的：看板定时刷新让结果自动浮出来；并拉存疑库（徽标计数）
    const timer = setInterval(() => {
      loadBoard();
      if (viewRef.current !== "uncertain") loadUncertain();
    }, 10_000);
    return () => clearInterval(timer);
  }, [loadBoard, loadUncertain]);

  // Esc 分层退出：审核页处于前台时 Esc → 回看板（05§六；设置/悬浮窗等层压在它之上）
  useEffect(() => {
    if (view !== "uncertain") return;
    return pushEscLayer(() => setView("board"));
  }, [view]);

  // 全局键盘（05§六）：Esc 分层退出——各层自注册进栈，这里只负责消费
  useEffect(() => {
    /** 全局键处理：Esc 交给分层栈（最上层先退）。 */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleEsc();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 开合对话面板：状态与记忆一处收敛（05§一）。 */
  const setChat = (open: boolean) => {
    setChatOpen(open);
    saveChatOpen(open);
  };
  /** 切换对话面板开合。 */
  const toggleChat = () => setChat(!chatOpen);

  /** 事项 chips 深链（05§三）：切回看板 + 清筛选 + 收起面板（记忆同步）+ 交看板定位展开。 */
  const requestFocus = (id: string) => {
    setView("board");
    setFilter({ query: "", tags: [] });
    setChat(false);
    setFocus({ id, token: Date.now() });
  };

  /** 加/删一个标签 token（标签栏与看板行上的 tag 共用此入口）。 */
  const toggleFilterTag = (tag: string) => {
    setFilter((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((x) => x !== tag) : [...f.tags, tag],
    }));
  };

  const allTags = useMemo(() => {
    if (board === null) return [];
    return [
      ...new Set([...board.undated, ...board.scheduled, ...board.done].flatMap((r) => r.item.tags)),
    ].sort();
  }, [board]);

  /** @ 提及候选：全部事项（含已归档——提及历史事项合理）。 */
  const chatItems = useMemo(() => {
    if (board === null) return [];
    return [...board.undated, ...board.scheduled, ...board.done, ...board.archived].map((r) => ({
      id: r.item.id,
      title: itemName(r.item.elements),
    }));
  }, [board]);

  return (
    <div className="flex h-screen overflow-hidden">
      <ActivityBar
        view={view}
        uncertainCount={uncertain.length}
        onHome={() => {
          if (view !== "board") {
            setView("board");
            return;
          }
          mainRef.current?.scrollTo({ top: 0 });
        }}
        onShowUncertain={() => {
          setView("uncertain");
          loadUncertain(); // 进页即拉一次（审核期间轮询已暂停——见上）
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        {/* 全视图横幅（D-89 评审 C1：审核页也必须有错误面——不许拿旧数据/假空态说事） */}
        {error !== null && <Banner text={error} />}
        {uncertainError !== null && <Banner text={uncertainError} />}

        {view === "uncertain" ? (
          <UncertainReview items={uncertain} onRemoved={loadUncertain} />
        ) : (
          <>
            {/* 顶部整栏筛选（token 堆左、搜索框占满）+ 对话开关 */}
            <div className="flex items-center gap-2 px-4 pt-4">
              <FilterBar filter={filter} allTags={allTags} onChange={setFilter} />
              <button
                title={chatOpen ? "收起对话面板" : "打开对话面板"}
                onClick={toggleChat}
                className={cn("btn shrink-0", chatOpen && "border-accent/60 bg-accent-soft")}
              >
                {chatOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </button>
            </div>

            {/* 标签栏：默认折叠，点开见全部标签，点击 = 加/删 token（用户 2026-09-27 定） */}
            <div className="px-4 pt-2">
              <button
                className="flex cursor-pointer items-center gap-1 text-xs text-ink-muted hover:text-ink"
                onClick={() => setTagsOpen((open) => !open)}
              >
                {tagsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                标签{allTags.length > 0 ? `（${allTags.length}）` : ""}
              </button>
              {tagsOpen && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {allTags.length === 0 && (
                    <span className="text-xs text-ink-muted">
                      还没有标签——事项带了标签就会出现在这
                    </span>
                  )}
                  {allTags.map((t) => (
                    <button
                      key={t}
                      className={cn(
                        "chip cursor-pointer",
                        filter.tags.includes(t) && "border-accent bg-accent-soft text-accent",
                      )}
                      onClick={() => toggleFilterTag(t)}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {board !== null && board.failedRawInputs.length > 0 && (
              <div className="mx-4 mt-2 flex items-center gap-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
                <span>
                  有 {board.failedRawInputs.length} 条信息处理失败，已标「未处理」——原文没丢。
                </span>
                <button
                  className="btn"
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true);
                    // allSettled：个别批次已被别处重试（409）不算失败——刷新看板如实呈现即可
                    void Promise.allSettled(
                      board.failedRawInputs.map((r) => api.retryRaw(r.id)),
                    ).then(() => {
                      window.setTimeout(loadBoard, 1500);
                      setRetrying(false);
                    });
                  }}
                >
                  {retrying ? "重试中…" : "重试这批"}
                </button>
              </div>
            )}

            {board !== null ? (
              <Board
                board={board}
                onRefresh={loadBoard}
                focus={focus}
                filter={filter}
                onTagClick={toggleFilterTag}
              />
            ) : (
              <p className="px-4 py-8 text-sm text-ink-muted">加载中…</p>
            )}
          </>
        )}
      </div>

      {chatOpen && (
        <aside
          className={cn(
            "flex-col bg-surface",
            // 窄屏（<1024）全屏化覆盖主区；宽屏= 420px 停靠（05§一）
            "fixed inset-0 z-30 flex lg:static lg:z-auto lg:w-[420px] lg:shrink-0 lg:border-l lg:border-line",
          )}
        >
          <ChatPanel
            items={chatItems}
            onActivity={() => window.setTimeout(loadBoard, 1500)}
            onRequestFocus={requestFocus}
            onClose={toggleChat}
          />
        </aside>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
