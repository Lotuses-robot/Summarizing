import { useEffect, useRef } from "react";
import { ScrollText } from "lucide-react";
import changelogRaw from "../../../../CHANGELOG.md?raw";
import { Markdown } from "../lib/markdown";
import { parseChangelog } from "../lib/changelog";
import { pushEscLayer } from "../lib/escLayer";

// 更新日志（用户 2026-10-13 定）：**公告 = 更新日志**——不做单独的公告横幅系统，所有公告都写进
// CHANGELOG.md。本组件两种形态：
//   ① 自动弹窗：登录后若本设备看过的版本 ≠ CHANGELOG 最新版本 → 弹一次"这版更新了什么"；
//   ② 常驻入口：设置面"更新日志"点开可回看全部历史版本。
// 内容经 vite `?raw` 打包进前端（零后端、零网络），版本唯一出处 = CHANGELOG.md。

/** 已读版本的本机键（每设备记一次——同外观偏好，localStorage）。 */
const SEEN_KEY = "summarizing.seenVersion";

/** CHANGELOG 里最新（首个）版本号；无版本段（只有 [未发布]）返回 null。 */
function latestVersion(): string | null {
  return parseChangelog(changelogRaw)[0]?.version ?? null;
}

/** 本设备是否该弹"更新了什么"——有新版（且非首次安装）才弹。 */
export function shouldShowChangelog(): boolean {
  const latest = latestVersion();
  if (latest === null) return false;
  const seen = localStorage.getItem(SEEN_KEY);
  // 首次安装（从未记过）：不弹（用户刚来，没有"更新"概念）；对话历史等回填即初始体验
  if (seen === null) {
    localStorage.setItem(SEEN_KEY, latest); // 记下当前版，避免下次误弹
    return false;
  }
  return seen !== latest;
}

/** 标记当前版本已读（弹窗关闭时调用）。 */
export function markChangelogSeen(): void {
  const latest = latestVersion();
  if (latest !== null) localStorage.setItem(SEEN_KEY, latest);
}

/** 更新日志弹层：渲染全部版本段（最新在上），每段 Markdown 复用既有渲染器。 */
export function ChangelogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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

  const versions = parseChangelog(changelogRaw);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-[10vh_1rem_1rem]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <ScrollText size={16} className="text-ink-muted" />
          <span className="font-semibold">更新日志</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {versions.length === 0 ? (
            <p className="text-sm text-ink-muted">（暂无更新记录）</p>
          ) : (
            versions.map((v) => (
              <section key={v.version} className="mb-6 last:mb-0">
                <h3 className="mb-2 text-sm font-semibold text-accent">{v.version}</h3>
                <div className="text-sm">
                  <Markdown text={v.body} />
                </div>
              </section>
            ))
          )}
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
