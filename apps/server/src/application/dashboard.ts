import { existsSync, statfsSync } from "node:fs";
import path from "node:path";
import { errText, type DashboardSnapshot } from "@summarizing/shared";
import { DashboardSnapshotSchema } from "@summarizing/shared";
import { listAccounts, type RegistryDb } from "../storage/registry";
import {
  aggregateTokenTotals,
  readUserDbStats,
  tokenTotal,
  type TokenSums,
  type UserDbStats,
} from "../storage/stats";
import { appVersion } from "../shared/version";
import { beijingDayStart, wallClockFromDate } from "../shared/time";

// 公开状态面板的聚合与应用层（011）：只读各账户库 → 白名单快照。
// 公开面无认证：这里**只能**产出 DashboardSnapshotSchema 里的字段——内容/uid/路径一列都不 select。
// 单库失败只降级（degraded + databases.failed），不拖垮整体；页面永远 200，除非从未成功聚合。

/** 进程启动时刻（模块加载即进程启动）：运行时长从这里起算，重启不会伪装成「一直在跑」。 */
const PROCESS_STARTED_AT_MS = Date.now();

/** 快照缓存时长：60 秒内重复请求不重复打库（FR-005）。 */
const DASHBOARD_TTL_MS = 60_000;

/** 每 IP 每窗口的请求上限（公开接口的兜底限流）。 */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

/** 累计聚合值（跨账户）。 */
interface Totals {
  raw: number;
  digested: number;
  digestFailed: number;
  calls: number;
  pending: number;
  digesting: number;
  failedRaw: number;
  tasks: number;
  notices: number;
  trashed: number;
  malformed: number;
  mediaCount: number;
  mediaBytes: number;
}

/** 把单个账户库的统计并入总计（原地累加，不保留账户维度）。 */
function addStats(totals: Totals, s: UserDbStats): void {
  totals.raw += s.rawToday;
  totals.digested += s.digestedToday;
  totals.digestFailed += s.failedToday;
  totals.calls += s.callsToday;
  totals.pending += s.pending;
  totals.digesting += s.digesting;
  totals.failedRaw += s.failedRaw;
  totals.tasks += s.tasks;
  totals.notices += s.notices;
  totals.trashed += s.trashed;
  totals.malformed += s.malformedItems;
  totals.mediaCount += s.mediaCount;
  totals.mediaBytes += s.mediaBytes;
}

/** 数据盘剩余/总容量；statfs 不可用（平台差异/路径异常）→ null（页面显示「—」，不拿 0 冒充）。 */
function readDisk(dataRoot: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = statfsSync(dataRoot);
    return {
      freeBytes: Math.max(0, Math.floor(s.bavail * s.bsize)),
      totalBytes: Math.max(0, Math.floor(s.blocks * s.bsize)),
    };
  } catch {
    return null;
  }
}

/** 排行榜用户名的公开形态：只露前两个字（码点计）+「…」（用户 2026-10-21 定）。
 *  截断在**服务端**做——`curl /api/dashboard` 拿到的就是截断后的名字，不靠前端藏。 */
function publicRankName(username: string): string {
  const cps = Array.from(username);
  return cps.length <= 2 ? username : `${cps.slice(0, 2).join("")}…`;
}

/** 排行排序：总量降序，并列按用户名升序（码点序——刷新不跳动）。 */
function compareRanking(
  a: { fullName: string; tokens: number },
  b: { fullName: string; tokens: number },
): number {
  if (a.tokens !== b.tokens) return b.tokens - a.tokens;
  if (a.fullName < b.fullName) return -1;
  if (a.fullName > b.fullName) return 1;
  return 0;
}

/** 采集一次全量快照（同步、只读）：账户库逐个打开聚合 → 合并 → 排行截断 → 运行时资源。 */
export function collectDashboardSnapshot(args: {
  registry: RegistryDb;
  dataRoot: string;
  now: Date;
}): DashboardSnapshot {
  const since = beijingDayStart(args.now);
  const accounts = listAccounts(args.registry);
  const totals: Totals = {
    raw: 0,
    digested: 0,
    digestFailed: 0,
    calls: 0,
    pending: 0,
    digesting: 0,
    failedRaw: 0,
    tasks: 0,
    notices: 0,
    trashed: 0,
    malformed: 0,
    mediaCount: 0,
    mediaBytes: 0,
  };
  const usageToday: TokenSums[] = [];
  const usageTotal: TokenSums[] = [];
  const ranking: Array<{ fullName: string; tokens: number }> = [];
  let dbTotal = 0;
  let dbOpened = 0;
  let dbFailed = 0;

  for (const account of accounts) {
    const file = path.join(args.dataRoot, "users", `${account.uid}.db`);
    // 从未登录的新账户没有库文件——跳过，不算故障（Edge Cases）
    if (!existsSync(file)) continue;
    dbTotal += 1;
    let stats: UserDbStats;
    try {
      stats = readUserDbStats(file, since);
    } catch (err) {
      dbFailed += 1;
      // 留痕到 stderr（运维可见），绝不进公开响应
      process.stderr.write(
        `[dashboard] 账户 ${account.username} 的库读取失败（跳过）：${errText(err)}\n`,
      );
      continue;
    }
    dbOpened += 1;
    addStats(totals, stats);
    usageToday.push(stats.usageToday);
    usageTotal.push(stats.usageTotal);
    if (account.status === "active") {
      const tokens = tokenTotal(stats.usageTotal);
      // 0 token 的账户不上榜（2026-10-21 走查）：榜单回答「谁用得多」，
      // 没调用过的账户占着第二名只是噪音，且与「暂无数据」的空态自相矛盾。
      if (tokens > 0) ranking.push({ fullName: account.username, tokens });
    }
  }

  // 服务端截断：响应里永远最多两项、名字只露前两字（不靠前端隐藏）
  ranking.sort(compareRanking);
  const topTwo = ranking
    .slice(0, 2)
    .map((r) => ({ name: publicRankName(r.fullName), tokens: r.tokens }));

  const nowIso = wallClockFromDate(args.now);
  return DashboardSnapshotSchema.parse({
    version: appVersion(),
    startedAt: wallClockFromDate(new Date(PROCESS_STARTED_AT_MS)),
    now: nowIso,
    uptimeSec: Math.max(0, Math.floor((args.now.getTime() - PROCESS_STARTED_AT_MS) / 1000)),
    memory: { rssBytes: process.memoryUsage().rss },
    disk: readDisk(args.dataRoot),
    databases: { total: dbTotal, opened: dbOpened, failed: dbFailed },
    accounts: {
      total: accounts.length,
      active: accounts.filter((a) => a.status === "active").length,
    },
    today: {
      rawBatches: totals.raw,
      digested: totals.digested,
      digestFailed: totals.digestFailed,
      llmCalls: totals.calls,
    },
    queue: { pending: totals.pending, digesting: totals.digesting },
    failedRawInputs: totals.failedRaw,
    items: { tasks: totals.tasks, notices: totals.notices, trashed: totals.trashed },
    media: { count: totals.mediaCount, bytes: totals.mediaBytes },
    tokens: {
      today: aggregateTokenTotals(usageToday),
      total: aggregateTokenTotals(usageTotal),
    },
    tokenRanking: topTwo,
    // 坏库或畸形数据都算「部分数据不可读」——不静默
    degraded: dbFailed > 0 || totals.malformed > 0,
    generatedAt: nowIso,
    cached: false,
  });
}

/** 公开状态服务：快照缓存 + 单飞 + 每 IP 限流。 */
export interface DashboardService {
  /** 取快照（60s 内直接复用；并发请求共享同一次聚合；刷新失败有旧快照则带 cached=true 返回）。 */
  snapshot(): Promise<DashboardSnapshot>;
  /** 该 IP 此刻是否仍有配额（固定窗口 60 次/分）。 */
  allow(ip: string): boolean;
}

/** 造状态服务（now 可注入——测试推进时钟用；生产缺省取系统时钟）。 */
export function makeDashboardService(args: {
  registry: RegistryDb;
  dataRoot: string;
  now?: () => Date;
}): DashboardService {
  const now = args.now ?? ((): Date => new Date());
  let cached: DashboardSnapshot | null = null;
  let cachedAtMs = 0;
  let inflight: Promise<DashboardSnapshot> | null = null;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  /** 重新聚合并更新缓存（单飞的唯一计算入口）。 */
  const refresh = async (): Promise<DashboardSnapshot> => {
    const at = now();
    const snap = collectDashboardSnapshot({ ...args, now: at });
    cached = snap;
    cachedAtMs = at.getTime();
    return snap;
  };

  return {
    async snapshot(): Promise<DashboardSnapshot> {
      const t = now().getTime();
      if (cached !== null && t - cachedAtMs < DASHBOARD_TTL_MS) {
        return { ...cached, cached: true };
      }
      if (inflight === null) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      try {
        return await inflight;
      } catch {
        if (cached !== null) return { ...cached, cached: true, degraded: true };
        throw new Error("状态暂不可用");
      }
    },

    allow(ip: string): boolean {
      const t = now().getTime();
      // 键数有界：窗口过期即清（公开面扫段 IP 也不会无限涨）
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) {
          if (t >= v.resetAt) buckets.delete(k);
        }
      }
      const b = buckets.get(ip);
      if (b === undefined || t >= b.resetAt) {
        buckets.set(ip, { count: 1, resetAt: t + RATE_WINDOW_MS });
        return true;
      }
      if (b.count >= RATE_LIMIT) return false;
      b.count += 1;
      return true;
    },
  };
}
