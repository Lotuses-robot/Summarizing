import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { nowWallClock } from "../shared/time";

// schema 迁移三件套（批次 2 / docs/11 阶段 2）：**版本号 + 迁移前自动备份 + 逐库跑**。
// 逐库跑：由调用方（index 启动遍历账户、每库 makeDb）天然保证——本模块只管单库的版本门控。
// 版本记录用 SQLite 内建 `PRAGMA user_version`（整数）：两库通用、零建表（用户库没有 meta 表）。
// 「仅向前」：回滚 = 恢复备份 + 回退镜像 tag（不写 down 迁移）。

/** 当前 schema 版本（**代码常量，唯一出处**）。改表结构时 +1：新结构写进 ensureSchema 的幂等 DDL
 *  （db.ts / registry.ts 各自主体），存量变换同样写在 ensureSchema 里（先例：migrateByToProvenance）。
 *  v2（007）：取消归档状态——存量 archived 快照迁移为 done（FR-018）。
 *  v3（010）：新增 llm_usage（token 用量）——纯建表，无存量变换。
 *  v4（009）：新增 media（图片缓存生命周期）——纯建表，无存量变换。
 *  v5（012 / D-127）：术语改名——source_type → source、source_identity → identity_json，
 *    保留键 sourceLabel → displayName（列名幂等改名 + 存量 JSON 键改名）。
 *  v6（012 / D-127）：全文检索——raw_inputs 加 tokens / identity_tokens、建 FTS5 虚表 raw_fts，
 *    存量批次切词回填 + 索引重建。
 *  v7（013 / D-130）：系统库新增 relay_settings（部署级信源设置）——纯建表，无存量变换。 */
export const SCHEMA_VERSION = 7;

/** 备份保留份数（超过按时间清最旧——防无限堆积）。 */
const BACKUP_KEEP = 5;

/** 读库内 schema 版本（PRAGMA user_version；新库为 0）。 */
export function readSchemaVersion(sqlite: Database.Database): number {
  const row = sqlite.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : 0;
}

/** 写库内 schema 版本。 */
function writeSchemaVersion(sqlite: Database.Database, version: number): void {
  // PRAGMA 不支持参数绑定；version 是受控整数常量，无注入面
  sqlite.pragma(`user_version = ${version}`);
}

/**
 * 打开一个库句柄并过版本门控（开库生命周期单出处：makeDb / makeRegistryDb 共用）。
 * mkdir 父目录 → 开库 → 文件库开 WAL → runSchemaGate；**门控失败关句柄再抛**——上层的启动失败
 * 与「按请求重试装配」都不会泄漏连接。返回的句柄已建表就绪，调用方只需再套 drizzle。
 * @param file 库文件路径（":memory:" 跳过目录/WAL/备份——测试内存库）
 * @param applyDdl 幂等建表 + 存量迁移的回调（本库自己的 ensureSchema 主体）
 */
export function openGatedDb(
  file: string,
  applyDdl: (sqlite: Database.Database) => void,
): Database.Database {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  if (file !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }
  try {
    runSchemaGate(sqlite, file, () => applyDdl(sqlite));
  } catch (err) {
    try {
      sqlite.close(); // 半开不留句柄
    } catch {
      // 已关/未开——忽略，别盖住原始错误
    }
    throw err;
  }
  return sqlite;
}

/**
 * 版本门控建表/迁移：给已打开的库跑「当前版本」的 schema 自愈 + 迁移。
 * - 库内版本**落后** → 先备份（仅此情形）→ 跑迁移回调 → 写新版本（迁移与版本写入同一事务）；
 * - 库内版本**持平** → 不备份、直接跑幂等 DDL（自愈），**不动版本**；
 * - 库内版本**领先**（降级旧二进制）→ 同持平处理，但往 stderr 留痕（红线「不许静默」）。
 *
 * 调用时机：由 openGatedDb 在建表前调用（备份要在改动落盘前完成）——本模块外请用 openGatedDb。
 * @param sqlite 已打开的库句柄
 * @param file 库文件路径（":memory:" 跳过备份——测试内存库无文件）
 * @param applyDdl 幂等建表 + 存量迁移的回调（本库自己的 ensureSchema 主体）
 */
function runSchemaGate(sqlite: Database.Database, file: string, applyDdl: () => void): void {
  const current = readSchemaVersion(sqlite);
  const needsMigrate = current < SCHEMA_VERSION;
  // 全新库（version 0 且无任何表）= 首次建库，无数据可备——备份只在「已有内容的老库」上做。
  const needsBackup = needsMigrate && file !== ":memory:" && (current > 0 || hasAnyTable(sqlite));

  // 降级运行（旧二进制开新库，docs/11 回滚流程会遇到）：按设计自愈不迁，但红线「不许静默」——留痕。
  if (current > SCHEMA_VERSION) {
    process.stderr.write(
      `[schema] 库版本 ${current} 领先代码 ${SCHEMA_VERSION}（降级运行）：跑幂等自愈、不动版本（${file}）\n`,
    );
  }

  // 迁移前自动备份（仅在真要迁移时——正常启动零开销）。备份失败**中止迁移**（不回滚地改表更危险）。
  if (needsBackup) backupBeforeMigrate(sqlite, file, current);
  if (needsMigrate) {
    // 迁移与版本写入同一事务：崩溃窗口不再产生「表已改、版本仍旧」的半迁移态——
    // 要么全落盘，要么全回滚（下次启动按旧版本重放幂等 DDL）。
    sqlite.transaction(() => {
      applyDdl();
      writeSchemaVersion(sqlite, SCHEMA_VERSION);
    })();
  } else {
    applyDdl(); // 持平/领先：幂等建表 + 存量迁移（IF NOT EXISTS / 幂等 UPDATE 自愈老库），不动版本
  }
}

/** 库里是否已有任何表（判「老库」用——全新空库 = 无表）。 */
function hasAnyTable(sqlite: Database.Database): boolean {
  return (
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get() !== undefined
  );
}

/** 迁移前备份：`<dir>/backup/<名>-v<旧版本>-<北京时间戳>.db`。**同步**（不把 makeDb 变 async）：
 *  先 WAL checkpoint(TRUNCATE) 把已提交内容落主库文件——checkpoint 真正完成才是一致快照
 *  （busy 即中止：宁可迁移不跑，也不产出假备份），再拷主库文件。保留最近 BACKUP_KEEP 份。
 *  备份失败抛错 → 中止迁移（不带着未备份的库改表）。
 *  幂等：同 (库,旧版本) 已有备份即跳过——迁移失败会在装配重试路径上被反复触发，迁移是回滚事务、
 *  库内容不变，不必每请求重做一次全库拷。
 *
 *  ⚠️ 为何这里用同步 checkpoint+拷贝、而不用 SQLite `.backup` API（R12「非裸拷」的解读）：
 *  本函数跑在**启动早期、进程刚开库、服务尚未 listen**——此刻本进程是该库**唯一连接、无并发写者**，
 *  checkpoint 后拷到的即一致快照；`.backup` API 是为「运行中并发读写」发明的，此处用不上，且它是 async
 *  （会把整个 makeDb 链变 async、波及 40+ 调用点）。**运行中/在线备份走 `.backup` API**——见 backup.ts。
 *  两者分工：迁移前=同步快照（适配启动期），在线备份=异步 `.backup`（适配运行期）。 */
function backupBeforeMigrate(sqlite: Database.Database, file: string, fromVersion: number): void {
  const dir = path.join(path.dirname(file), "backup");
  const base = path.basename(file, path.extname(file));
  // 已有同版本备份（上次迁移失败/回滚留下的忠实快照）→ 不重做（目录不存在 = 无备份，直接往下走）
  if (
    existsSync(dir) &&
    readdirSync(dir).some((f) => f.startsWith(`${base}-v${fromVersion}-`) && f.endsWith(".db"))
  ) {
    return;
  }
  // busy=1 = 有并发读者/写者令 TRUNCATE 未完成：主库文件尚缺已提交事务，此时拷出的「备份」会被
  // 当成回滚安全网——比没有备份更危险。直接抛错（与「备份失败中止迁移」同一底线：宁停不改）。
  const busy = sqlite.pragma("wal_checkpoint(TRUNCATE)", { simple: true });
  if (busy !== 0) {
    throw new Error(`迁移前备份失败：WAL checkpoint 未完成（busy）——中止迁移：${file}`);
  }
  mkdirSync(dir, { recursive: true });
  // 北京时间戳（D-97 单出处 nowWallClock）；':' 在 Windows 文件名非法 → 换 '-'，与全库墙钟同形状可比
  const stamp = nowWallClock().replace(/[:.]/g, "-"); // 2026-10-12T09-14-41
  const target = path.join(dir, `${base}-v${fromVersion}-${stamp}.db`);
  copyFileSync(file, target); // checkpoint 已完成：主库文件即完整一致快照
  pruneBackups(dir, base);
}

/** 保留最近 BACKUP_KEEP 份 `<base>-v*.db`，多余按修改时间从旧到新删（同 mtime 按文件名兜底——
 *  文件名是排序友好的墙钟戳）；readdir 与 stat 之间消失的文件当不存在，不许因它中止启动。 */
function pruneBackups(dir: string, base: string): void {
  const mine: Array<{ f: string; mtimeMs: number }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${base}-v`) || !f.endsWith(".db")) continue;
    try {
      mine.push({ f, mtimeMs: statSync(path.join(dir, f)).mtimeMs });
    } catch {
      // 被外部清掉（手工/杀软瞬删）——跳过
    }
  }
  if (mine.length <= BACKUP_KEEP) return;
  mine.sort((a, b) => a.mtimeMs - b.mtimeMs || a.f.localeCompare(b.f)); // 旧在前
  for (const { f } of mine.slice(0, mine.length - BACKUP_KEEP)) {
    rmSync(path.join(dir, f), { force: true });
  }
}
