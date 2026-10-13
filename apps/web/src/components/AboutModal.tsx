import { useEffect, useRef } from "react";
import { BookMarked } from "lucide-react";
import changelogRaw from "../../../../CHANGELOG.md?raw";
import { Markdown } from "../lib/markdown";
import { parseChangelog } from "../lib/changelog";
import { pushEscLayer } from "../lib/escLayer";

// 关于弹层（用户 2026-10-13 定）：活动栏 ⓘ 打开——产品名/一句话/版本 + 更新日志。
// **不塞进设置**（设置 = 声明式偏好，展示型事务另立门户——同「用户卡」的先例）。
// 双触发共用本组件：① ⓘ 手动打开；② 发版后登录自动弹一次「这版更新了什么」。
// 内容经 vite `?raw` 打包进前端（零后端、零网络），版本唯一出处 = CHANGELOG.md。

/** 已读版本的本机键（每设备记一次——同外观偏好，localStorage）。 */
const SEEN_KEY = "summarizing.seenVersion";

/** CHANGELOG 里最新（首个）版本号；无版本段（只有 [未发布]）返回 null。 */
function currentVersion(): string | null {
  return parseChangelog(changelogRaw)[0]?.version ?? null;
}

/** 本设备是否该弹"更新了什么"——有新版（且非首次安装）才弹。 */
export function shouldShowChangelog(): boolean {
  const latest = currentVersion();
  if (latest === null) return false;
  const seen = localStorage.getItem(SEEN_KEY);
  // 首次安装（从未记过）：不弹（用户刚来，没有"更新"概念）
  if (seen === null) {
    localStorage.setItem(SEEN_KEY, latest); // 记下当前版，避免下次误弹
    return false;
  }
  return seen !== latest;
}

/** 标记当前版本已读（弹窗关闭时调用）。 */
export function markChangelogSeen(): void {
  const latest = currentVersion();
  if (latest !== null) localStorage.setItem(SEEN_KEY, latest);
}

/** 版本段列表（关于弹层内嵌用）——最新在上，Markdown 复用既有渲染器。 */
function ChangelogList() {
  const versions = parseChangelog(changelogRaw);
  if (versions.length === 0) {
    return <p className="text-sm text-ink-muted">（暂无更新记录）</p>;
  }
  return (
    <>
      {versions.map((v) => (
        <section key={v.version} className="mb-5 last:mb-0">
          <h3 className="mb-1.5 text-sm font-semibold text-accent">{v.version}</h3>
          <div className="text-sm text-ink">
            <Markdown text={v.body} />
          </div>
        </section>
      ))}
    </>
  );
}

/** 关于弹层：产品牌 + 一句话 + 当前版本 + 更新日志（全部版本，滚动区）。 */
export function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // Esc 分层退出（与设置/用户弹层同款）
  useEffect(() => {
    if (!open) return;
    return pushEscLayer(() => onCloseRef.current());
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-[10vh_1rem_1rem]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(540px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 产品牌区：主题色渐变头 + 圆角 logo——展示型弹层的"好看"预算都花在这 */}
        <header className="relative flex flex-col items-center gap-2 overflow-hidden px-6 pb-5 pt-7 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-accent-soft to-transparent opacity-70"
          />
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-surface shadow-md">
            <BookMarked size={26} />
          </div>
          <div className="relative">
            <h2 className="text-lg font-semibold">Summarizing</h2>
            <p className="mt-0.5 text-xs text-ink-muted">个人信息中枢 · 把碎片拼成完整的事项</p>
          </div>
          <span className="relative rounded-full border border-line bg-canvas px-2.5 py-0.5 text-xs text-ink-muted">
            {currentVersion() ?? "—"}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-6 py-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-muted">
            更新日志
          </p>
          <ChangelogList />
        </div>

        <footer className="flex justify-end border-t border-line px-5 py-3">
          <button className="btn" onClick={onClose}>
            知道了
          </button>
        </footer>
      </div>
    </div>
  );
}
