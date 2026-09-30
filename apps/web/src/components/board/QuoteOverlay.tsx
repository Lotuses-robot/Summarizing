import { useEffect, useRef } from "react";
import { sourceIdentityLabel, type RawInput } from "@summarizing/shared";
import { pushEscLayer } from "../../lib/escLayer";

/** 引文悬浮窗（05§三 ㉜）：显示所属批次完整原文并高亮引文那句；点遮罩 / Esc 关闭。
 *  高亮用 indexOf 精确定位，定位不到（引文与原文有空白差异）就整段平铺不高亮——如实展示不编造。 */
export function QuoteOverlay({
  rawInput,
  quote,
  onClose,
}: {
  rawInput: RawInput;
  quote: string;
  onClose: () => void;
}) {
  // Esc 分层退出：挂载期间注册本层（05§六）；onClose 走 ref——重渲染不换层位
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => pushEscLayer(() => closeRef.current()), []);

  const idx = rawInput.content.indexOf(quote);

  return (
    // 遮罩点击 = 关闭；内层 stopPropagation 让阅读区的点击不冒泡
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <div
        className="mx-auto mt-[10vh] w-[min(640px,92vw)] rounded-lg border border-line bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-muted">
          <span className="truncate">
            批次 {rawInput.id.slice(0, 6)} · {new Date(rawInput.receivedAt).toLocaleString()} ·{" "}
            {sourceIdentityLabel(rawInput.sourceIdentity)}
          </span>
          <button className="btn shrink-0" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
          {idx >= 0 ? (
            <>
              {rawInput.content.slice(0, idx)}
              <mark className="bg-accent-soft text-inherit">
                {rawInput.content.slice(idx, idx + quote.length)}
              </mark>
              {rawInput.content.slice(idx + quote.length)}
            </>
          ) : (
            rawInput.content
          )}
        </p>
      </div>
    </div>
  );
}
