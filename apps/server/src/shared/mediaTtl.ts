// 图片缓存留存规则单一出处（009 / 用户 2026-10-20 定）：
//   入库        → clamp(14天 − size/2MiB × 7天, 7天, 14天)（与大小反向）
//   读过未引用   → min(原值, 读取时刻 + 3 天)（只提前、不延后）
//   证据引用     → max(当前, 引用时刻 + 90 天)（证据链不断）
// `expiresAt` 是**唯一**生命周期字段：没有 readAt/citedAt 状态机（用户 2026-10-20 定「只要一个
// expireDate，agent0 干完自动更新，更新不到就算了」）。墙钟串是北京时间、无时区后缀；
// 加天数走 UTC 分量算术（北京无夏令时，结果与真实日历一致）。

/** 基础留存的满额基准（2 MiB）：插值用它当分母，「2 MiB 封顶 7 天」的锚点。
 *  与压缩目标无关——储存上限降到 500 KiB 后这个锚点没动（用户 2026-10-21：只限制大小）。 */
const MEDIA_TTL_ANCHOR_BYTES = 2 * 1024 * 1024;

/** 存储大小的硬上限（500 KiB，用户 2026-10-21 定）：>此值一律压缩到它以下再入库。
 *  远低于 agent0 的 2 MiB 读取闸，也低于大多数 CDN/模型上下文阈值。 */
export const MEDIA_TARGET_BYTES = 500 * 1024;

/** 单图输入硬上限（防解压炸弹/滥用）。 */
export const MEDIA_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** 像素硬上限（50MP，同 agent0 取图防线）。 */
export const MEDIA_MAX_PIXELS = 50_000_000;

/** 读过但未被引用的统一留存；证据引用的留存（用户 2026-10-20 复查：被引用的图
 *  不应随基础留存过期——证据链必须始终可查）。两者都只经本文件的目标值函数外用。 */
const MEDIA_UNCITED_DAYS = 3;
const CITED_TTL_DAYS = 90;

const DAY_MS = 86_400_000;
const MIN_TTL_DAYS = 7;
const MAX_TTL_DAYS = 14;

/** 基础留存时长（毫秒）：越小留得越久，2 MiB 封顶 7 天。 */
export function baseMediaTtlMs(sizeBytes: number): number {
  const ratio = Math.min(1, Math.max(0, sizeBytes / MEDIA_TTL_ANCHOR_BYTES));
  const days = MAX_TTL_DAYS - ratio * (MAX_TTL_DAYS - MIN_TTL_DAYS);
  return Math.round(Math.max(MIN_TTL_DAYS, Math.min(MAX_TTL_DAYS, days)) * DAY_MS);
}

/** 墙钟字符串 + 天数（纯日期算术，与时区无关）。非法输入抛错——不给脏值算命。
 *  只服务本文件的三个目标值函数——跨模块用统一走 nowWallClock 那侧。 */
function addDaysWallClock(wallClock: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(wallClock);
  if (m === null) throw new Error(`非法墙钟字符串：${wallClock}`);
  const base = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  const d = new Date(base + Math.round(days * DAY_MS));
  /** 两位数补零。 */
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 入库时的到期时刻：createdAt + 基础留存。 */
export function initialMediaExpiry(createdAt: string, sizeBytes: number): string {
  return addDaysWallClock(createdAt, baseMediaTtlMs(sizeBytes) / DAY_MS);
}

/** 读过未引用的到期时刻：readAt + 3 天（调用方负责取 min——这里只算目标值）。 */
export function uncitedMediaExpiry(readAt: string): string {
  return addDaysWallClock(readAt, MEDIA_UNCITED_DAYS);
}

/** 被证据引用的到期时刻：引用时刻 + 90 天（调用方负责取 max）。 */
export function citedMediaExpiry(citedAt: string): string {
  return addDaysWallClock(citedAt, CITED_TTL_DAYS);
}
