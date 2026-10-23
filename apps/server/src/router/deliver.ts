import type { SourceAdapter } from "../sources/types";
import type { Space, SpaceHub } from "../spaces";

// 投递（D-130）：Router 查明归属后，把原始消息交给那个账户的信源。
//
// 这一层的存在意义就一件事：**把「查账户」和「交消息」之间的失败分清楚**。
// 三种失败的含义完全不同，Router 要据此说不同的话：
//   · no_source —— 账户在，但这个信源没启用（用户关了开关）→ 回「暂不可用」
//   · no_account —— 账户不存在**或已停用** → 视为未绑定 → 回绑定码
//   · ensure_failed / timeout —— 装配失败或超时 → 留痕，这次不投
//
// 账户可接收性由 `hub.forDelivery` 判定（它查 status）——**不要**改用 `hub.ensure`：
// 那样停用账户照样会被装配，消息写进停用者的库、还用他的 key 消化。
//
// 所以它不抛异常，把三种情况都变成返回值。

/** 装配超时：首次投递会触发整个 Space 装配（建库 + 迁移 + 造信源）。
 *  10 秒是个保守上限——超过它多半是磁盘/锁问题，等下去只会拖住整轮拉取。 */
const ENSURE_TIMEOUT_MS = 10_000;

/** 投递结果。 */
export type DeliverResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no_account" | "no_source" | "rejected" | "ensure_failed";
      detail?: string;
    };

/** 把一条原始消息交给某账户的信源。
 *
 * @param hub 空间集线器
 * @param uid 目标账户
 * @param sourceName 信源名（"wecom" / "nc" …）
 * `input` = 原始消息与到达时刻（原样转给信源的 accept）。
 * `prepareSpace`（可选）= 装配好的空间上的额外接线。微信接入用它把自己
 *   「媒体占位取字节」的本事塞进该账户（`wecom-media:` 要 token，而 token 在 Router）。
 * @returns 成功或失败原因（不抛）
 */
export async function deliver(
  hub: SpaceHub,
  uid: string,
  sourceName: string,
  input: { raw: unknown; receivedAt: string },
  prepareSpace?: (space: Space) => void,
): Promise<DeliverResult> {
  // 账户不存在**或已停用** → 这条不该来（→ 视为未绑定）。判定由 hub 给返回值，
  // 不靠匹配错误串：措辞一改就会把「账户没了」误判成「装配失败」，答错一句话。
  let space;
  try {
    space = await withTimeout(hub.forDelivery(uid), ENSURE_TIMEOUT_MS);
  } catch (err) {
    return {
      ok: false,
      reason: "ensure_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (space === undefined) return { ok: false, reason: "no_account" };

  // 接线先于 accept：信源可能立刻封批，而落库后的图片缓存会马上查这张表
  prepareSpace?.(space);

  const source: SourceAdapter | undefined = space.source(sourceName);
  if (source === undefined) return { ok: false, reason: "no_source" };

  const result = source.accept(input);
  return result.ok ? { ok: true } : { ok: false, reason: "rejected", detail: result.reason };
}

/** 给一个 promise 套超时；超时抛错（由调用方归到 ensure_failed）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`装配超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
