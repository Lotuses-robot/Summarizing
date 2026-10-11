import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

// 设置页原语（macOS 系统设置式，用户 2026-09-30 定）：分组卡 + 一行一设置（左标签右控件）。
// SettingsModal 与 SourcesSection 共用这一套，保证整页节奏一致。

/** 分组卡：小标题（图标+名+一句灰描述）在上，卡内一行一设置；footnote 在卡下方（灰小字）。
 *  bare = 不套容器盒（内容自带卡片时用，如信源区——每源一张卡）。 */
export function Card({
  id,
  icon: Icon,
  title,
  desc,
  footnote,
  bare = false,
  children,
}: {
  /** 锚点 id（左导航滚动定位用；无则不挂）。 */
  id?: string;
  icon?: LucideIcon;
  title: ReactNode;
  desc?: ReactNode;
  footnote?: ReactNode;
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4">
      <header className="mb-2 flex items-center gap-1.5 px-0.5">
        {Icon !== undefined && <Icon size={14} className="text-ink-muted" />}
        <span role="heading" aria-level={3} className="text-sm font-semibold">
          {title}
        </span>
        {desc !== undefined && <span className="truncate text-xs text-ink-muted">· {desc}</span>}
      </header>
      {bare ? (
        children
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">{children}</div>
      )}
      {footnote !== undefined && <p className="mt-1.5 px-0.5 text-xs text-ink-muted">{footnote}</p>}
    </section>
  );
}

/** 设置行：左标签（可带灰描述）、右控件——控件右对齐成列；stacked = 控件换行全宽（复杂编辑器用）。
 *  children 无控件时可省（纯提示行，如「读取中…」）。 */
export function Row({
  label,
  description,
  stacked = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** true = 控件另起一行占满宽度（如键值对行编辑器）；默认左右布局。 */
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-t border-line px-4 py-2.5 first:border-t-0",
        !stacked && "flex min-h-11 items-center justify-between gap-6",
      )}
    >
      <div className={cn("min-w-0", !stacked && "flex-1")}>
        <p className="text-sm">{label}</p>
        {description !== undefined && (
          <div className="mt-0.5 text-xs text-ink-muted">{description}</div>
        )}
      </div>
      <div className={cn(stacked ? "mt-2" : "max-w-full shrink-0")}>{children}</div>
    </div>
  );
}

/** 分段控件（主题/字体/密度用）：macOS 式——底槽 + 选中白块，点了即生效。
 *  定宽 + 段等分（w-44 用 rem，密度档不缩控件）——同卡多个分段控件左缘对齐。 */
export function Segmented<T extends string>({
  value,
  options,
  labels,
  onPick,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onPick: (v: T) => void;
}) {
  return (
    <div className="flex w-44 rounded-lg border border-line bg-canvas p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          className={cn(
            "flex-1 cursor-pointer rounded-md px-2 py-1 text-center text-xs transition-colors",
            opt === value
              ? "bg-surface font-medium text-ink shadow-sm"
              : "text-ink-muted hover:text-ink",
          )}
          onClick={() => onPick(opt)}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}

/** 行内状态：按**字段键**存——同键新状态顶旧状态；不同键互不覆盖（失败不会被别的成功顶掉，评审 M4）。
 *  kind=flash 一闪即隐（成功，2.4s）· kind=sticky 常驻（失败，不静默——同键下次成功才消）。 */
export type RowStatus = { key: string; text: string; kind: "flash" | "sticky" };

/** 行内状态表（按字段键）。用法：`const { statuses, flash, sticky } = useStatus()`。 */
export function useStatus(): {
  statuses: RowStatus[];
  flash: (key: string, msg: string) => void;
  sticky: (key: string, msg: string) => void;
} {
  const [statuses, setStatuses] = useState<RowStatus[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  /** 以 key 为槽位写入状态（同键顶替）。 */
  const set = useCallback((key: string, text: string, kind: RowStatus["kind"]) => {
    const old = timers.current.get(key);
    if (old !== undefined) {
      clearTimeout(old);
      timers.current.delete(key);
    }
    setStatuses((cur) => [...cur.filter((s) => s.key !== key), { key, text, kind }]);
    if (kind === "flash") {
      timers.current.set(
        key,
        setTimeout(() => setStatuses((cur) => cur.filter((s) => s.key !== key)), 2400),
      );
    }
  }, []);

  /** 成功一闪：2.4s 后自动隐去。 */
  const flash = useCallback((key: string, msg: string) => set(key, msg, "flash"), [set]);
  /** 失败常驻：留到同键下一次成功（或下一次同键失败顶替）。 */
  const sticky = useCallback((key: string, msg: string) => set(key, msg, "sticky"), [set]);

  return { statuses, flash, sticky };
}

/** 卡尾状态槽（走查 2026-10-03 彻底修）：**无反馈即整槽不渲染**——有状态或 children 才出现
 *  （此前定高常驻 → 每张卡底部挂一条无字空框）。有状态时 min-h-2rem 领定高防文案切换抖高（评审 H）。
 *  ⚠️ children 传 `{cond && …}` 时条件不成立 = `false`（**算有内容**）——务必把条件提到槽外
 *  （`{cond ? <p/> : undefined}` 或外层 `{cond && <StatusSlot …/>}`），否则槽仍会空撑。 */
export function StatusSlot({
  statuses,
  children,
}: {
  statuses: RowStatus[];
  children?: ReactNode;
}) {
  if (
    statuses.length === 0 &&
    (children === null || children === undefined || children === false)
  ) {
    return null;
  }
  return (
    <div className="min-h-[2rem] border-t border-line px-4 py-2 text-xs">
      {children}
      {statuses.map((s) => (
        <p key={s.key} className={s.kind === "sticky" ? "text-danger" : "text-ink-muted"}>
          {s.text}
        </p>
      ))}
    </div>
  );
}
