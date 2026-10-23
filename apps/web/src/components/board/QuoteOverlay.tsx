import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { displayNameWithDetails, type MediaMap, type RawInput } from "@summarizing/shared";
import { pushEscLayer } from "../../lib/escLayer";
import { fmtFullTime } from "../../lib/time";
import { MediaText } from "./MediaText";
import { CloseButton } from "../CloseButton";

/** 引文悬浮窗（05§三 ㉜）：显示所属批次完整原文并高亮引文那句；点遮罩 / Esc 关闭。
 *  高亮用 indexOf 精确定位，定位不到（引文与原文有空白差异）就整段平铺不高亮——如实展示不编造。
 *  quote 为空串 = 非引文入口（从来源区的批次行进来，无特定待高亮句）→ 整段平铺。
 *  mediaMap = 原文里的图片占位 → 本地媒体（009：原链接过期也能看图；未命中按来源回退）。 */
export function QuoteOverlay({
  rawInput,
  quote,
  mediaMap,
  onClose,
}: {
  rawInput: RawInput;
  quote: string;
  mediaMap: MediaMap;
  onClose: () => void;
}) {
  // Esc 分层退出：挂载期间注册本层（05§六）；onClose 走 ref——重渲染不换层位
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => pushEscLayer(() => closeRef.current()), []);

  const idx = quote === "" ? -1 : rawInput.content.indexOf(quote);

  return createPortal(
    // 遮罩点击 = 关闭；内层 stopPropagation 让阅读区的点击不冒泡
    <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose}>
      <div
        className="mx-auto mt-[5dvh] w-[min(640px,92vw)] rounded-2xl border border-line bg-surface p-4 shadow-xl sm:mt-[10vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-muted">
          <span className="truncate">
            批次 {rawInput.id.slice(0, 6)} · {fmtFullTime(rawInput.receivedAt)} ·{" "}
            {displayNameWithDetails(rawInput.identity)}
          </span>
          <CloseButton onClick={onClose} label="关闭引文" className="-my-1 shrink-0" />
        </div>
        {/* whitespace-pre-wrap 保留原文换行；fit-text 让无空格长 URL 也在框内断行（不横向溢出） */}
        <div className="fit-text max-h-[70dvh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
          {idx >= 0 ? (
            <>
              <MediaText text={rawInput.content.slice(0, idx)} mediaMap={mediaMap} />
              <mark className="bg-accent-soft text-inherit">
                <MediaText
                  text={rawInput.content.slice(idx, idx + quote.length)}
                  mediaMap={mediaMap}
                />
              </mark>
              <MediaText text={rawInput.content.slice(idx + quote.length)} mediaMap={mediaMap} />
            </>
          ) : (
            <MediaText text={rawInput.content} mediaMap={mediaMap} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
