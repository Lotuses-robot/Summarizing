import { useEffect, useRef, useState } from "react";
import { Archive, Check, X } from "lucide-react";
import { sourceIdentityLabel, type UncertainInput } from "@summarizing/shared";
import { api } from "../api";
import { cn } from "../lib/cn";
import { pushEscLayer } from "../lib/escLayer";

/** 移除按钮（D-89 用户设计的「移动确认」交互——防误触）：
 *  idle = 归档图标；点击 → 原位变 X、左侧弹出勾——鼠标**移到勾上点击**才真删；
 *  移动本身即意图确认（勾离原位有距离，误点不会碰巧命中）。
 *  取消三路：X / 鼠标离开整组 / Esc（armed 期间注册进 Esc 分层栈——评审 H1 修正：
 *  原来的 span onKeyDown 是死代码，焦点根本不在它上面）；另有 document 指针兜底
 *  （触屏 tap 别处、指针静止而列表滚动等 mouseleave 覆盖不到的场景）。 */
function RemoveButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  const groupRef = useRef<HTMLSpanElement | null>(null);

  // armed 即入 Esc 栈（后注册先退——只消化掉自己这一层，不会连审核页一起弹掉）
  useEffect(() => {
    if (!armed) return;
    return pushEscLayer(() => setArmed(false));
  }, [armed]);

  // 指针兜底：armed 期间点组外任意处 = 取消（mouseleave 对触屏不可靠）
  useEffect(() => {
    if (!armed) return;
    /** 组外按下 → 取消（组内按下不动，交给两个按钮自己的 click）。 */
    const onPointerDown = (e: PointerEvent) => {
      const group = groupRef.current;
      if (group !== null && e.target instanceof Node && group.contains(e.target)) return;
      setArmed(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [armed]);

  if (!armed) {
    return (
      <button className="btn" title="清掉这条（会再确认一次）" onClick={() => setArmed(true)}>
        <Archive size={14} />
      </button>
    );
  }
  return (
    <span ref={groupRef} className="flex items-center gap-1" onMouseLeave={() => setArmed(false)}>
      <button
        className="btn border-warn/60 bg-warn-soft text-warn"
        title="确认清掉这条"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        <Check size={14} />
      </button>
      <button className="btn" title="取消" onClick={() => setArmed(false)}>
        <X size={14} />
      </button>
    </span>
  );
}

/** 存疑库审核页（D-89）：主视图（活动栏 ⚠ 切换）；只读简列表（needsHuman 倒序，后端已排）。
 *  不做清扫按钮/已处理回看（10§三 明确不做）——清扫走前台对话。 */
export function UncertainReview({
  items,
  onRemoved,
}: {
  items: UncertainInput[];
  /** 移除（或判定已不在）后通知外壳刷新列表（单一数据源在 App 轮询）。 */
  onRemoved: () => void;
}) {
  /** 逐条移除的进行态（行淡化为反馈；按钮未禁用——重复点的第二发会被服务端 404/409 幂等兜掉）。 */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /** 移除失败的可见提示（不静默——评审：500/断网原来无声吞掉）。 */
  const [note, setNote] = useState<string | null>(null);

  /** 确认移除一条：404/409 = 已被清扫并发处置（静默刷新收尾）；其余失败给可见提示。 */
  const remove = (id: string) => {
    setBusy((cur) => new Set(cur).add(id));
    api
      .resolveUncertain(id)
      .then(() => setNote(null))
      .catch(() => setNote("移除失败，稍后再试（条目仍在）"))
      .finally(() => {
        setBusy((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
        onRemoved();
      });
  };

  return (
    <section className="px-4 pb-8 pt-4">
      <h2 className="text-sm font-semibold">
        存疑库审核
        {items.length > 0 && (
          <span className="ml-2 text-xs text-ink-muted">{items.length} 条待定夺</span>
        )}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">
        拿不准的原始信息在这等你定夺——看完清掉即可（原话仍留档可查）。要 AI 复核就说「清扫存疑库」。
      </p>
      {note !== null && <p className="mt-2 text-xs text-danger">{note}</p>}
      {items.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">这里现在是空的——拿不准的信息会自动进来。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className={cn(
                "flex items-start gap-3 rounded-md border border-line bg-surface px-3 py-2",
                busy.has(it.id) && "opacity-50",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm">{it.content}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                  <span className="chip" title="需要人工定夺的程度（0-100，越高越急）">
                    需人工 {it.needsHuman}
                  </span>
                  <span>{it.reason}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {sourceIdentityLabel(it.sourceIdentity)} ·{" "}
                  {new Date(it.createdAt).toLocaleString()}
                </p>
              </div>
              <RemoveButton onConfirm={() => remove(it.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
