// Esc 分层退出（05§六）：设置弹层 → 悬浮窗 → 展开体 → 对话面板。
// 每个「层」在自己挂载期间注册收起函数；Esc 消费最上层（后注册的先退）——
// 注册顺序 ≈ 视觉叠放顺序（后开的总在上面）。

const layers: (() => void)[] = [];

/** 注册一层 Esc 处理；返回注销函数（组件卸载时调用）。 */
export function pushEscLayer(close: () => void): () => void {
  layers.push(close);
  return () => {
    const i = layers.indexOf(close);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** Esc 被按下：让最上层收起。有层可退返回 true（外层就别再处理），没有返回 false。 */
export function handleEsc(): boolean {
  const top = layers[layers.length - 1];
  if (top === undefined) return false;
  top();
  return true;
}
