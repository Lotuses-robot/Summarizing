import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

// 逐行横滑手势（唯一实现）：通知主卡与看板行共用。
// 右滑 = 删除（进回收站）、左滑 = 本条的主推进（通知=稍后、看板=完成/撤销）。
//
// 为什么不用 CSS `touch-action` 了事：横滑要「竖向留给原生滚动、横向才接管」——
// 靠 native touchmove 里 preventDefault 才拦得住；只挂 pointermove 时浏览器会在移动
// 28px 左右把指针收走（实测），手势根本走不完。
// 拖动期间**直接写 DOM**（transform / opacity），不 setState——长列表逐帧重渲染会很卡。

/** 判定横向的起手位移（px）：小于它不锁轴（避免抖动误判）。 */
const AXIS_LOCK_PX = 8;
/** 撤销窗口（秒）：滑动删除后先不写库，留这么久可反悔（看板行与通知主卡共用）。 */
export const UNDO_SECONDS = 2;

/** 位移上限 = 容器宽度的这个比例（拖到底也不会把行甩出去）。 */
const DRAG_LIMIT_RATIO = 0.6;

/** 横滑结果方向：right = 向右拖，left = 向左拖。 */
export type SwipeDir = "left" | "right";

/** 一个方向提示层的显隐（直接改 DOM，不触发重渲染）。 */
function setSideVisible(root: HTMLElement, side: SwipeDir, visible: boolean): void {
  const el = root.querySelector<HTMLElement>(`[data-side='${side}']`);
  if (el !== null) el.style.visibility = visible ? "visible" : "hidden";
}

/** 横滑手势钩子：把 ref 绑到要跟着手指走的元素上，把 handlers 绑到同一元素。 */
export function useSwipeActions({
  enabled,
  onSwipe,
  ratio,
}: {
  /** false 时完全不接手势（锁住、正在撤销窗口里、或展开态）。 */
  enabled: boolean;
  /** 过阈值后触发；info = 松手时的位移（px）与速度（px/ms，带方向）——
   *  调用方据此让后续动画从当前速度接着走，而不是从静止重新起步。 */
  onSwipe: (dir: SwipeDir, info: { dx: number; velocity: number }) => void;
  /** 阈值 = 容器宽度的比例。 */
  ratio: number;
}): {
  /** 跟着手指平移的那个元素。 */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** 底层动作提示层（其子元素用 `data-side="left|right"` 声明两侧提示）。 */
  revealRef: RefObject<HTMLDivElement | null>;
  /** 本次按下是否真的横向拖过（用来吞掉拖动结束后的 click）。 */
  movedRef: RefObject<boolean>;
  /** 让被拖动的元素立刻回到原位（清内联位移与临时 transition）。过阈值时钩子**故意不清位移**
   *  （留给位移动画从松手处接），所以**不做位移动画的调用方要在动作开始时自己调它**。 */
  resetPosition: () => void;
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
} {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const revealRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);
  /** 最近两次横向采样：松手时算释放速度（px/ms）。 */
  const samplesRef = useRef<{ t: number; x: number }[]>([]);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    width: number;
    axis: "none" | "x" | "y";
  } | null>(null);
  const dxRef = useRef(0);
  /** 最新回调（原生监听只挂一次，闭包不能过期）。 */
  const cbRef = useRef({ enabled, onSwipe, ratio });
  useEffect(() => {
    cbRef.current = { enabled, onSwipe, ratio };
  });

  /** 起手：交互元素上不启动拖动（点按钮/链接要正常）。
   *  两块标记改写这条默认：
   *  - `data-swipe-through`（收起的行内标签条）：交互元素也让过——横拖归整行，
   *    否则起手落在标签上就既滑不动标签、也滑不动行，成了死区；
   *  - `data-swipe-own`（展开的行内标签条）：整个区域都不起手——那里横拖是标签自己的横滑。 */
  const beginDrag = (target: EventTarget | null, x: number, y: number, width: number): void => {
    if (!cbRef.current.enabled) return;
    if (target instanceof Element) {
      if (target.closest("[data-swipe-own]") !== null) return;
      if (
        target.closest("button,a,summary,input,textarea,select") !== null &&
        target.closest("[data-swipe-through]") === null
      )
        return;
    }
    dragRef.current = { startX: x, startY: y, width, axis: "none" };
    dxRef.current = 0;
    movedRef.current = false;
    samplesRef.current = [{ t: performance.now(), x }];
    if (bodyRef.current !== null) {
      bodyRef.current.style.transition = "none";
      bodyRef.current.style.userSelect = "none"; // 拖动中别顺带选中文字
    }
    if (revealRef.current !== null) {
      revealRef.current.style.display = "block";
      setSideVisible(revealRef.current, "left", false);
      setSideVisible(revealRef.current, "right", false);
    }
  };

  /** 移动一帧：先定轴向（横向才拖动）；位移限制在 ±60% 宽；底层提示随位移加深。 */
  const moveDrag = (x: number, y: number): void => {
    const d = dragRef.current;
    if (d === null) return;
    if (d.axis === "none") {
      const ax = Math.abs(x - d.startX);
      const ay = Math.abs(y - d.startY);
      if (Math.max(ax, ay) < AXIS_LOCK_PX) return;
      d.axis = ax > ay ? "x" : "y";
      if (d.axis === "x") movedRef.current = true;
    }
    if (d.axis !== "x") return;
    const limit = d.width * DRAG_LIMIT_RATIO;
    const dx = Math.max(-limit, Math.min(limit, x - d.startX));
    dxRef.current = dx;
    // 只留最近两个采样：更早的对速度没意义，还会把一次减速误算成匀速
    const samples = samplesRef.current;
    samples.push({ t: performance.now(), x });
    if (samples.length > 2) samples.shift();
    if (bodyRef.current !== null) bodyRef.current.style.transform = `translateX(${dx}px)`;
    const strength = Math.min(1, Math.abs(dx) / Math.max(1, d.width * cbRef.current.ratio));
    if (revealRef.current !== null) {
      revealRef.current.style.opacity = String(0.35 + strength * 0.65);
      // 只亮当前方向那一侧的提示（另一侧被行遮着，亮着也是死字）
      setSideVisible(revealRef.current, "left", dx > 0);
      setSideVisible(revealRef.current, "right", dx < 0);
    }
  };

  /** 复位拖动期间写下的临时样式与底层提示层（只动 DOM，不改状态）。 */
  const resetDragVisuals = (): void => {
    if (bodyRef.current !== null) {
      bodyRef.current.style.transition = "";
      bodyRef.current.style.transform = "";
      bodyRef.current.style.userSelect = "";
    }
    if (revealRef.current !== null) {
      revealRef.current.style.display = "none";
      // 下一次拖动重新按方向点亮（否则会继承上一次的可见性）
      setSideVisible(revealRef.current, "left", false);
      setSideVisible(revealRef.current, "right", false);
    }
  };

  /** 松手：过阈值即交给调用方（右/左），否则回弹。
   *  ⚠️ 过阈值时**不把位移清零**：行停在手指松开的位置，由调用方接着往同一方向播完
   *  （清零会让行先瞬间弹回原点再滑出去——肉眼就是「滑到一半停一下又接着滑」）。 */
  const finishDrag = (): void => {
    const d = dragRef.current;
    dragRef.current = null;
    const dx = dxRef.current;
    dxRef.current = 0;
    if (d === null) return;
    const threshold = d.width * cbRef.current.ratio;
    const dir: SwipeDir | null = dx >= threshold ? "right" : dx <= -threshold ? "left" : null;
    if (dir === null) {
      resetDragVisuals(); // 没过阈值：回弹
      return;
    }
    // 释放速度（px/ms，带方向）：最近两次采样的位移/时间差；采样不足或时间差为 0 → 0。
    // 调用方用它给后续动画定初速——不交速度，动画就只能从静止起步，手感会「一顿」。
    const [a, b] = samplesRef.current;
    const velocity =
      a !== undefined && b !== undefined && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
    // 过阈值：保留当前位置，只摘掉拖动期间临时写的 transition/userSelect
    if (bodyRef.current !== null) {
      bodyRef.current.style.transition = "";
      bodyRef.current.style.userSelect = "";
    }
    if (revealRef.current !== null) revealRef.current.style.display = "none";
    cbRef.current.onSwipe(dir, { dx, velocity });
  };

  /** 手势被系统取消（pointercancel/touchcancel）：只回弹，不执行动作。 */
  const abortDrag = (): void => {
    dragRef.current = null;
    dxRef.current = 0;
    resetDragVisuals();
  };

  /** 触屏用最新手势函数（原生监听只挂一次）。 */
  const gestureRef = useRef({ beginDrag, moveDrag, finishDrag, abortDrag });
  useEffect(() => {
    gestureRef.current = { beginDrag, moveDrag, finishDrag, abortDrag };
  });

  // 触屏：touchmove 非 passive——判定为横向后 preventDefault，浏览器才不会把它当滚动/后退收走
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    /** 单指起手（多指 = 缩放等，不接管）。 */
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t === undefined || e.touches.length > 1) return;
      gestureRef.current.beginDrag(e.target, t.clientX, t.clientY, el.clientWidth);
    };
    /** 单指移动：定轴后横向 preventDefault；竖向不拦（原生滚动）。 */
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t === undefined) return;
      gestureRef.current.moveDrag(t.clientX, t.clientY);
      if (dragRef.current !== null && dragRef.current.axis === "x") e.preventDefault();
    };
    /** 单指结束：与鼠标同一收尾。 */
    const onTouchEnd = () => {
      if (dragRef.current !== null) gestureRef.current.finishDrag();
    };
    /** 手势被系统收走（来电/系统导航等）：只回弹。 */
    const onTouchCancel = () => {
      if (dragRef.current !== null) gestureRef.current.abortDrag();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchCancel);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, []);

  /** 鼠标/触控笔按下（触屏走上面的原生 touch 监听）。 */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    beginDrag(e.target, e.clientX, e.clientY, e.currentTarget.clientWidth);
    if (dragRef.current !== null) e.currentTarget.setPointerCapture(e.pointerId);
  };
  /** 鼠标/触控笔移动。 */
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    moveDrag(e.clientX, e.clientY);
  };
  /** 鼠标/触控笔松开。 */
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    finishDrag();
  };
  /** 鼠标/触控笔取消：只回弹，不动作。 */
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    abortDrag();
  };

  return {
    bodyRef,
    revealRef,
    movedRef,
    /** 让被拖动的元素立刻回到原位（清掉内联位移与临时 transition）。
     *  过阈值时钩子**故意不清位移**（留给位移动画从松手处接），所以不用位移动画的调用方要自己调它。 */
    resetPosition: resetDragVisuals,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
