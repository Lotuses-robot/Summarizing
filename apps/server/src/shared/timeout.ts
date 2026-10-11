// 超时兜底单出处（006 /simplify）：race + unref 定时器 + 必清。
// 「任一侧挂起不许拖住流程」（Ctrl-C 可停、启动不卡死）的收尾语义曾抄写三份
// （gracefulClose / closeSpacesWithTimeout / startWithTimeout）——差异只在超时值、错误文案
// 与 catch 归属；这里只留机制，留痕各调用点自理。

/** 给 work 套一个 ms 超时：超时以 `Error(message)` reject；work 先完成则原样透传（含它自身的 reject）。 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref(); // 进程活着只为等它——race 结束后定时器不许拖住退出
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
