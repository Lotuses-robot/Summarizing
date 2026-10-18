import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  itemName,
  errText,
  type BoardView,
  type MeView,
  type NoticeView,
  type NoticeRow,
  type TrashView,
  type UncertainInput,
} from "@summarizing/shared";
import { api, setOnUnauthorized } from "./api";
import { ActivityBar, type View } from "./components/ActivityBar";
import { AuthShell } from "./components/AuthShell";
import { FilterBar, matchesFilter, type BoardFilter } from "./components/FilterBar";
import { Board } from "./components/Board";
import { NoticePanel } from "./components/NoticePanel";
import { TrashPanel } from "./components/TrashPanel";
import { UncertainReview } from "./components/UncertainReview";
import { PipelineView } from "./components/pipeline/PipelineView";
import { ChatPanel } from "./components/chat/ChatPanel";
import { SettingsModal } from "./components/settings/SettingsModal";
import { UserModal } from "./components/UserModal";
import {
  AboutModal,
  lastSeenVersion,
  markChangelogSeen,
  shouldShowChangelog,
} from "./components/AboutModal";
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

/** 应用外壳（05§一 布局；006 起前置认证闸门）：未登录只有认证壳（备案号挂那）、登录后进主界面。
 *  主界面 = 最左活动栏（主视图切换）+ 顶部整栏筛选 + 主区（看板/存疑库审核/流水）+ 右侧停靠对话面板。
 *  录入统一走对话输入（投递条已砍）；未选标签收在筛选栏下方的「标签」栏（默认折叠）。 */
export default function App() {
  const [me, setMe] = useState<MeView | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authProbeError, setAuthProbeError] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [notices, setNotices] = useState<NoticeView | null>(null);
  const [trash, setTrash] = useState<TrashView | null>(null);
  const [uncertain, setUncertain] = useState<UncertainInput[]>([]);
  const [view, setView] = useState<View>("board"); // 主视图切换（007：看板/通知/存疑库/流水/回收站）
  const [error, setError] = useState<string | null>(null);
  const [uncertainError, setUncertainError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // 窄屏（<1024）对话面板是全屏覆盖——首启默认收起，别让手机用户一进来就看板不可见
  const [chatOpen, setChatOpen] = useState<boolean>(
    () => window.innerWidth >= 1024 && loadChatOpen(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // 关于弹层（2026-10-13）：活动栏 ⓘ 手动打开；发版后登录也自动弹一次「这版更新了什么」。
  // upgradeFrom：自动弹时记下"上次看过的版本"（头部渲染「旧 → 新」）；手动打开为 null。
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutUpgradeFrom, setAboutUpgradeFrom] = useState<string | null>(null);
  useEffect(() => {
    if (me !== null && shouldShowChangelog()) {
      setAboutUpgradeFrom(lastSeenVersion());
      setAboutOpen(true);
    }
  }, [me]);
  const [tagsOpen, setTagsOpen] = useState(false); // 标签栏默认折叠（用户 2026-09-27 定）
  const [filter, setFilter] = useState<BoardFilter>({ query: "", tags: [] });
  const [focus, setFocus] = useState<{ id: string; token: number } | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);

  /** 会话代次（评审修复）：登出/换号即 ++——在飞响应据此作废（A 的迟到数据不许落到 B 的界面）。 */
  const genRef = useRef(0);

  /** 统一「回到未登录」（单点拦截回调 + 登出共用）：清会话与数据态——并发 401 幂等。 */
  const handleUnauthenticated = useCallback(() => {
    genRef.current += 1;
    setMe(null);
    setBoard(null);
    setNotices(null);
    setNoticesError(null);
    setTrash(null);
    setTrashError(null);
    setUncertain([]);
    setSettingsOpen(false);
    setAccountOpen(false);
    setAboutOpen(false); // 弹层也要清——否则换账户/重登时残影（评审 2026-10-13）
    setAboutUpgradeFrom(null);
  }, []);

  // 启动探测：me 200 → 主界面；401（未登录的正常首屏路径）→ 认证壳；
  // 其余错误（网络/5xx）= 后端不可达——在认证壳上如实提示（评审修复：曾与 401 一并吞掉）。
  // 同时把 401 单点拦截接到全局（任何受保护请求 401 都切回认证壳）。
  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((v) => {
        if (alive) setMe(v);
      })
      .catch((err: unknown) => {
        if (alive && !errText(err).includes("401")) {
          setAuthProbeError("后端服务未连接——请确认服务已启动（apps/server）");
        }
      })
      .finally(() => {
        if (alive) setAuthChecked(true);
      });
    setOnUnauthorized(handleUnauthenticated);
    return () => {
      alive = false;
      setOnUnauthorized(null);
    };
  }, [handleUnauthenticated]);

  /** 拉看板；后端不在时挂横幅（不打断已渲染内容）。会话代次守卫：旧会话在飞响应丢弃。 */
  const loadBoard = useCallback(() => {
    const gen = genRef.current;
    api
      .board()
      .then((b) => {
        if (genRef.current !== gen) return;
        setBoard(b);
        setError(null); // 恢复连线就撤横幅——错误态不滞留
      })
      .catch(() => {
        if (genRef.current !== gen) return;
        setError("后端服务未连接（apps/server 是否在跑？）");
      });
  }, []);

  /** 拉通知（007）：通知页数据 + 活动栏未读徽标共用同一份。 */
  /** 拉通知（007）：通知页数据 + 活动栏未读徽标共用同一份。
   *  失败用**独立**错误态（别与看板共享 error——看板每 10s 成功轮询会把它清掉，
   *  通知页就会拿假空态说事）。 */
  const [noticesError, setNoticesError] = useState<string | null>(null);
  const loadNotices = useCallback(() => {
    const gen = genRef.current;
    api
      .notices()
      .then((n) => {
        if (genRef.current !== gen) return;
        setNotices(n);
        setNoticesError(null);
      })
      .catch(() => {
        if (genRef.current !== gen) return;
        setNoticesError("通知拉取失败——列表可能不是最新的");
      });
  }, []);

  /** 拉回收站（007）：进页即拉（清理/恢复都即时刷新，不靠轮询兜）。
   *  失败**必须可见**（红线「不许静默」）——否则空列表会被当成「回收站是空的」（假空态）。 */
  const [trashError, setTrashError] = useState<string | null>(null);
  const loadTrash = useCallback(() => {
    const gen = genRef.current;
    api
      .trashList()
      .then((t) => {
        if (genRef.current !== gen) return;
        setTrash(t);
        setTrashError(null);
      })
      .catch(() => {
        if (genRef.current !== gen) return;
        setTrashError("回收站拉取失败——列表可能不是最新的");
      });
  }, []);

  /** 拉存疑库 open 列表（D-89）：审核页数据 + 活动栏徽标计数共用同一份。
   *  失败置可见错误（不静默——否则审核页会拿旧数据/假空态说事，评审 Critical）。 */
  const loadUncertain = useCallback(() => {
    const gen = genRef.current;
    api
      .uncertain("open")
      .then((list) => {
        if (genRef.current !== gen) return;
        setUncertain(list);
        setUncertainError(null);
      })
      .catch(() => {
        if (genRef.current !== gen) return;
        setUncertainError("存疑库拉取失败——列表与计数可能已过期");
      });
  }, []);

  // 轮询看的是「当前视图」——审核页在前台时暂停拉存疑库（破坏性列表不许在读者手底下位移），
  // 看板数据照刷；离开审核页后下个周期自然恢复。用 ref 取最新视图，防 effect 重建定时器。
  // 登录态门：未登录不轮询（401 单点拦截会把界面切回认证壳，轮询没有对象）。
  const authed = me !== null;
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view; // 渲染期不写 ref（React 约定），effect 里同步
  }, [view]);
  useEffect(() => {
    if (!authed) return;
    loadBoard();
    loadNotices();
    loadUncertain();
    // agent0 消化是异步的：看板定时刷新让结果自动浮出来；并拉通知（未读徽标）与存疑库（徽标计数）
    const timer = setInterval(() => {
      loadBoard();
      loadNotices();
      if (viewRef.current !== "uncertain") loadUncertain();
    }, 10_000);
    return () => clearInterval(timer);
  }, [authed, loadBoard, loadNotices, loadUncertain]);

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

  /** 退出登录（评审修复）：**服务端确认清了 cookie 才回认证壳**——失败如实提示，不装作已退出
   *  （共用设备上残留会话仍在；旧文案「残留 cookie 会被 401 兜住」在失败场景为假）。 */
  const logout = () => {
    void api
      .logout()
      .then(handleUnauthenticated)
      .catch(() => setError("退出失败：服务暂时不可达——当前会话仍未注销，请稍后再试"));
  };

  /** 事项 chips 深链（05§三）：切回看板 + 清筛选 + 收起面板（记忆同步）+ 交看板定位展开。 */
  /** 事项 chips 深链（05§三）：按 id 所在视图切过去 + 清筛选 + 收起面板 + 交出定位。
   *  通知不在看板——命中通知时切到通知页（否则 chips 点了会"什么也没发生"）。 */
  const requestFocus = (id: string) => {
    const inNotices = notices?.notices.some((r) => r.item.id === id) ?? false;
    setView(inNotices ? "notice" : "board");
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

  /** @ 提及候选：看板三段 + 通知（OQ-9：@ 提及候选收录通知）——提及历史信息合理。 */
  const chatItems = useMemo(() => {
    const boardRows = board === null ? [] : [...board.undated, ...board.scheduled, ...board.done];
    const noticeRows = notices?.notices ?? [];
    return [...boardRows, ...noticeRows].map((r) => ({
      id: r.item.id,
      title: itemName(r.item.elements),
    }));
  }, [board, notices]);

  /** 通知未读数（活动栏徽标，OQ-10）：纯计数，有未读才显示。
   *  形状防御：`notices` 字段缺席（异常载荷/接口降级）时按 0 计——徽标缺省不显示，
   *  不让一处脏数据把整个界面打白（与详情页「派生失败降级」同一取向）。 */
  const unreadNoticeCount = useMemo(() => {
    const rows = notices?.notices ?? [];
    return rows.filter((r) => !r.viewed).length;
  }, [notices]);

  /** 通知的标签全集（筛选栏用，与看板 allTags 同性质——只看通知自己的）。 */
  const noticeTags = useMemo(() => {
    const rows = notices?.notices ?? [];
    return [...new Set(rows.flatMap((r) => r.item.tags))].sort();
  }, [notices]);

  /** 通知筛选谓词：语义单一出处 = FilterBar.matchesFilter（与看板共用，防两套真相）。 */
  const noticeVisible = useCallback(
    (r: NoticeRow): boolean => matchesFilter(r.item, filter),
    [filter],
  );

  // 认证闸门（hooks 全部就位之后的分支渲染）
  if (!authChecked) {
    return <p className="px-4 py-8 text-sm text-ink-muted">加载中…</p>;
  }
  if (me === null) {
    return (
      <AuthShell
        onAuthed={(v) => {
          genRef.current += 1; // 换号代次——旧会话在飞响应作废
          setAuthProbeError(null);
          setMe(v);
        }}
        notice={authProbeError}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <ActivityBar
        view={view}
        uncertainCount={uncertain.length}
        unreadNoticeCount={unreadNoticeCount}
        onHome={() => {
          if (view !== "board") {
            setView("board");
            return;
          }
          mainRef.current?.scrollTo({ top: 0 });
        }}
        onShowNotice={() => setView("notice")}
        onShowUncertain={() => {
          setView("uncertain");
          loadUncertain(); // 进页即拉一次（审核期间轮询已暂停——见上）
        }}
        onShowPipeline={() => setView("pipeline")}
        onShowTrash={() => {
          setView("trash");
          loadTrash();
        }}
        onOpenAccount={() => setAccountOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAbout={() => {
          setAboutUpgradeFrom(null); // 手动打开不是"升级场景"——不显示旧→新
          setAboutOpen(true);
        }}
      />

      <div ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        {/* 全视图横幅（D-89 评审 C1：审核页也必须有错误面——不许拿旧数据/假空态说事） */}
        {error !== null && <Banner text={error} />}
        {noticesError !== null && <Banner text={noticesError} />}
        {uncertainError !== null && <Banner text={uncertainError} />}
        {trashError !== null && <Banner text={trashError} />}

        {view === "notice" ? (
          <>
            {/* 通知页（007）：筛选栏与看板同款（tag + 文本），不另造机制 */}
            <div className="flex items-center gap-2 px-4 pt-4">
              <FilterBar filter={filter} allTags={noticeTags} onChange={setFilter} />
            </div>
            <NoticePanel
              notices={notices?.notices ?? []}
              filter={noticeVisible}
              onRefresh={loadNotices}
              focus={focus}
            />{" "}
          </>
        ) : view === "uncertain" ? (
          <UncertainReview items={uncertain} onRemoved={loadUncertain} />
        ) : view === "pipeline" ? (
          <PipelineView />
        ) : view === "trash" ? (
          <TrashPanel rows={trash?.rows ?? []} onRefresh={loadTrash} />
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
      <UserModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        me={me}
        onLogout={logout}
        onTokenRotated={(token) =>
          setMe((cur) => (cur === null ? cur : { ...cur, sourceToken: token }))
        }
      />
      <AboutModal
        open={aboutOpen}
        showUpgradeFrom={aboutUpgradeFrom}
        onClose={() => {
          markChangelogSeen(); // 关掉即记本设备已读——自动弹以后不再弹
          setAboutOpen(false);
        }}
      />
    </div>
  );
}
