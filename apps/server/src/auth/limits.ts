// 登录/注册限速（006 R6 / contracts/http.md）：进程内滑窗——单进程单人运维足够；
// 策略进代码常量（「系统策略进代码」原则）；重启即重置（接受并记录，见 research R6）。

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILS = 5;
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_MAX = 10;

/** 超过该键数做一次全量清理（防垃圾用户名把 Map 撑大——单进程长跑的自愈）。 */
const PRUNE_ABOVE_KEYS = 1000;

const loginFails = new Map<string, number[]>();
const registerHits = new Map<string, number[]>();

/** 登录锁定键：用户名 + 来源 IP 的**对**——防「拿别人用户名锁人」的 DoS（受害者从自己 IP 不受影响）。 */
export function loginKey(username: string, ip: string): string {
  return `${username}\u0000${ip}`;
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

/** 注册端点限速（按来源 IP）：超出返回 true（路由转 429）——防邀请码枚举。 */
export function registerRateLimited(ip: string, now = Date.now()): boolean {
  const stamps = pruneStamps(registerHits.get(ip) ?? [], now, REGISTER_WINDOW_MS);
  if (stamps.length >= REGISTER_MAX) {
    registerHits.set(ip, stamps);
    return true;
  }
  stamps.push(now);
  registerHits.set(ip, stamps);
  pruneAllIfHuge(registerHits, now, REGISTER_WINDOW_MS);
  return false;
}

/** 测试用：清空全部限速状态（模块态，用例间隔离）。 */
export function resetLimitsForTest(): void {
  loginFails.clear();
  registerHits.clear();
}
