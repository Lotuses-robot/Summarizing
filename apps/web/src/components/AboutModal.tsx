import { useEffect, useRef } from "react";
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

/** 读已读版本；存储被禁（隐私模式等）返回 null（同 lib/appearance 的守卫——不许把整站带崩）。 */
function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** 写已读版本；写不进就放弃（记忆非数据）。 */
function writeSeen(version: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, version);
  } catch {
    // 静默放弃：隐私模式等场景，弹窗最多重复出现，不影响功能
  }
}

/** CHANGELOG 里最新（首个）版本号；无版本段（只有 [未发布]）返回 null。 */
function currentVersion(): string | null {
  return parseChangelog(changelogRaw)[0]?.version ?? null;
}

/** 本设备上次看过的版本（自动弹窗据此渲染「旧 → 新」）；从未记过 → null。 */
export function lastSeenVersion(): string | null {
  return readSeen();
}

/** 本设备是否该弹"更新了什么"（纯判断，**不写状态**——写入只在 markChangelogSeen/关闭时）。
 *  seen === null（从未记过）也弹：本功能首发版（v0.3.0）要能被存量设备看到；新装设备首登看一次
 *  "这版有什么"也是合理欢迎（一次性、可关）。此后 seen !== latest 才弹（真更新）。 */
export function shouldShowChangelog(): boolean {
  const latest = currentVersion();
  if (latest === null) return false;
  return readSeen() !== latest;
}

/** 标记当前版本已读（关闭弹窗时调用）。 */
export function markChangelogSeen(): void {
  const latest = currentVersion();
  if (latest !== null) writeSeen(latest);
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
          <div className="fit-text text-sm text-ink">
            <Markdown text={v.body} />
          </div>
        </section>
      ))}
    </>
  );
}

/** 版本号排序比较（`v0.3.0` / `v0.2.0-rc.1` 数字段比较）；任一侧不可解析 → 返回 null（弃权）。 */
function compareVersions(a: string, b: string): number | null {
  /** 拆 `v<主>.<次>.<修>` 为数字段；不可解析 → null（弃权）。 */
  const parse = (v: string): number[] | null => {
    const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 关于弹层：大仓库 README 风头部（超大居中图标/标题/信息基座）+ 更新日志（全部版本，滚动区）。
 *  `showUpgradeFrom`：本次是"更新后首次打开"→ 版本 chip 显示「旧 → 新」（手动打开不传）。
 *  ⚠️ 仅当旧版**确实更旧**（排序比较 <0）才显箭头；回滚（旧版更新）或不可比较 → 退化为纯当前版 chip。 */
export function AboutModal({
  open,
  onClose,
  showUpgradeFrom = null,
}: {
  open: boolean;
  onClose: () => void;
  /** 旧版本号（更新弹窗场景）；null = 手动打开，只显当前版。 */
  showUpgradeFrom?: string | null;
}) {
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

  const version = currentVersion();
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-[10vh_1rem_1rem]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(540px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部（大仓库 README 风）：点阵底纹+主题光晕 → 超大图标（应用图标，与 favicon/PWA 同一份）→ 超大标题 → 基座 chips */}
        <header className="about-hero relative flex flex-col items-center px-6 pb-6 pt-9 text-center">
          <img src="/favicon.svg" alt="" width={64} height={64} className="relative h-16 w-16" />
          <h2 className="relative mt-4 text-3xl font-bold tracking-tight">Summarizing</h2>
          <p className="relative mt-2 text-sm text-ink-muted">
            个人信息中枢 · 把碎片拼成完整的事项
          </p>
          {/* 信息基座：更新场景显「旧 → 新」（仅真升级）；平时只显当前版；另挂许可/开源 */}
          <div className="relative mt-4 flex flex-wrap items-center justify-center gap-1.5 text-xs">
            {showUpgradeFrom !== null &&
            version !== null &&
            (compareVersions(showUpgradeFrom, version) ?? 0) < 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-accent-soft px-2.5 py-0.5 font-medium text-accent">
                {showUpgradeFrom}
                <span aria-hidden>→</span>
                {version}
              </span>
            ) : (
              <span className="rounded-full border border-line bg-canvas px-2.5 py-0.5 text-ink-muted">
                {version ?? "—"}
              </span>
            )}
            <span className="rounded-full border border-line bg-canvas px-2.5 py-0.5 text-ink-muted">
              AGPL-3.0
            </span>
            <span className="rounded-full border border-line bg-canvas px-2.5 py-0.5 text-ink-muted">
              开源
            </span>
          </div>
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
