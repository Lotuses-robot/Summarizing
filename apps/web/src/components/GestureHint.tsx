import { useEffect, useState } from "react";
import { MoveHorizontal } from "lucide-react";

/** 首次使用的手势教程（2026-10-27 用户定：改成最经典的「黑色遮盖 + 指引」做法）。
 *
 *  形态：整屏压一层半透明黑幕（`fixed inset-0` + `bg-black/70`），中间一张深色卡片写明
 *  「右滑做什么 / 左滑做什么」，底部一颗「知道了」。点卡片外或按 Esc 也算知道。
 *
 *  为什么从「页面顶部一条提示条」换成黑幕：
 *  · 提示条在正文里，一扫而过就没了，用户还没学会怎么滑它就已经消失；
 *  · 黑幕是**模态**的——不点掉就一直在，阅读顺序被强行打断一次，反而更容易记住；
 *  · 这也是绝大多数 App 教手势的通行做法（用户点名要「最经典的黑色遮盖」）。
 *
 *  代价是打断阅读，所以**每个页面只出现一次**（本机记忆，滑过一次或点「知道了」即永久收起）。
 *  文案由调用方给——它知道这一页的手势语义。 */
export function GestureHint({
  title,
  lines,
  onDismiss,
}: {
  /** 一句话标题（这一页在教什么）。 */
  title: string;
  /** 逐条说明（一行一个手势）。 */
  lines: string[];
  /** 用户知道了（点按钮 / 点黑幕 / 按 Esc）——调用方负责记已读并卸载。 */
  onDismiss: () => void;
}) {
  /** 入场淡入：首帧透明 → 下一帧不透明（避免「啪」地出现）。 */
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(t);
  }, []);

  // Esc 也能关（与全站 Esc 分层一致：这一层在最上面，先消费掉）
  useEffect(() => {
    /** 黑幕期间的 Esc 只关教程。 */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
      }
    };
    // capture：抢在 App 的全局 Esc 之前处理掉，免得一次 Esc 同时关了下面的层
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onDismiss]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 transition-opacity duration-200 ${
        shown ? "opacity-100" : "opacity-0"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // 点黑幕任意处 = 知道了（不逼用户去找按钮）
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#1c1c1e] p-5 text-white shadow-2xl"
        // 点卡片本身不该关（只有「知道了」或点外部才关）
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <MoveHorizontal size={18} className="shrink-0" />
          {title}
        </div>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-white/80">
          {lines.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="text-white/40">
                ·
              </span>
              <span className="min-w-0 flex-1">{line}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            className="cursor-pointer rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
            onClick={onDismiss}
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
