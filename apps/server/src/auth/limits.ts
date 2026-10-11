// 登录/注册限速（006 R6 / contracts/http.md）：进程内滑窗——单进程单人运维足够；
// 策略进代码常量（「系统策略进代码」原则）；重启即重置（接受并记录，见 research R6）。

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_IP_WINDOW_MS = 10 * 60_000;
const LOGIN_IP_MAX = 30;
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_MAX = 10;

/** 超过该键数做一次全量清理（防垃圾用户名把 Map 撑大——单进程长跑的自愈）。 */
const PRUNE_ABOVE_KEYS = 1000;

const loginFails = new Map<string, number[]>();
const loginIpHits = new Map<string, number[]>();
const registerHits = new Map<string, number[]>();

/** 限速表全集（重置的单一清单——新加限速表挂进这里，别靠人肉记忆记「重置要加一行」）。 */
const LIMIT_TABLES: Array<Map<string, number[]>> = [loginFails, loginIpHits, registerHits];

/** 登录锁定键：用户名 + 来源 IP 的**对**——防「拿别人用户名锁人」（受害者从自己 IP 不受影响）。
 *  用户名按查库同口径先折叠（NFKC+trim+小写）——防大小写变体各享一份锁定预算（评审修复）。 */
export function loginKey(username: string, ip: string): string {
  return `${username.normalize("NFKC").trim().toLowerCase()}\u0000${ip}`;
}

/** 清掉窗口外的旧时间戳（就地更新数组）。 */
function pruneStamps(stamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < stamps.length && (stamps[i] ?? 0) <= cutoff) i += 1;
  return i === 0 ? stamps : stamps.slice(i);
}

/** Map 过大时的全量清理（删除所有窗口已空的键；窗口按各表自己的窗口传）。 */
function pruneAllIfHuge(map: Map<string, number[]>, now: number, windowMs: number): void {
  if (map.size <= PRUNE_ABOVE_KEYS) return;
  for (const [key, stamps] of map) {
    if (stamps.length === 0 || (stamps.at(-1) ?? 0) <= now - windowMs) map.delete(key);
  }
}

/** 登录是否被锁；被锁返回剩余秒数（0 = 未锁）。 */
export function loginLockRemainingSec(key: string, now = Date.now()): number {
  const stamps = pruneStamps(loginFails.get(key) ?? [], now, LOGIN_WINDOW_MS);
  loginFails.set(key, stamps);
  if (stamps.length < LOGIN_MAX_FAILS) return 0;
  const oldest = stamps[stamps.length - LOGIN_MAX_FAILS] ?? now;
  return Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000));
}

/** 记一次登录失败（连续失败达阈值即进入锁定窗口）。 */
export function recordLoginFailure(key: string, now = Date.now()): void {
  const stamps = pruneStamps(loginFails.get(key) ?? [], now, LOGIN_WINDOW_MS);
  stamps.push(now);
  loginFails.set(key, stamps);
  pruneAllIfHuge(loginFails, now, LOGIN_WINDOW_MS);
}

/** 登录成功 → 清空该键（成功即翻篇）。 */
export function clearLoginFailures(key: string): void {
  loginFails.delete(key);
}

/** 滑窗判限公共体（simplify 收敛）：达上限返回 true（不记新事件）；否则记一次并返回 false。
 *  登录对键单列——它带 retryAfterSec 计算与「成功清键」语义，不强行并入。 */
function hitRateLimited(
  table: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  max: number,
): boolean {
  const stamps = pruneStamps(table.get(key) ?? [], now, windowMs);
  if (stamps.length >= max) {
    table.set(key, stamps);
    return true;
  }
  stamps.push(now);
  table.set(key, stamps);
  pruneAllIfHuge(table, now, windowMs);
  return false;
}

/** 登录按 IP 的**总量**限速（评审修复）：防随机用户名连刷——每次 miss 都跑真 scrypt，
 *  不给对键锁定（每用户名独立）留打满 CPU 的口子。超限 true → 路由 429。 */
export function loginIpRateLimited(ip: string, now = Date.now()): boolean {
  return hitRateLimited(loginIpHits, ip, now, LOGIN_IP_WINDOW_MS, LOGIN_IP_MAX);
}

/** 注册端点限速（按来源 IP）：超出返回 true（路由转 429）——防邀请码枚举。 */
export function registerRateLimited(ip: string, now = Date.now()): boolean {
  return hitRateLimited(registerHits, ip, now, REGISTER_WINDOW_MS, REGISTER_MAX);
}

/** 测试用：清空全部限速状态（模块态，用例间隔离）。 */
export function resetLimitsForTest(): void {
  for (const table of LIMIT_TABLES) table.clear();
}
