import type Database from "better-sqlite3";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { wallClockFromDate } from "../shared/time";

// schema 迁移三件套（批次 2 / docs/11 阶段 2）：**版本号 + 迁移前自动备份 + 逐库跑**。
// 逐库跑：由调用方（index 启动遍历账户、每库 makeDb）天然保证——本模块只管单库的版本门控。
// 版本记录用 SQLite 内建 `PRAGMA user_version`（整数）：两库通用、零建表（用户库没有 meta 表）。
// 「仅向前」：回滚 = 恢复备份 + 回退镜像 tag（不写 down 迁移）。

/** 当前 schema 版本（**代码常量，唯一出处**）。改表结构时 +1：新结构写进 ensureSchema 的幂等 DDL
 *  （db.ts / registry.ts 各自主体），存量变换同样写在 ensureSchema 里（先例：migrateByToProvenance）。 */
export const SCHEMA_VERSION = 1;

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
 * 版本门控建表/迁移：给已打开的库跑「当前版本」的 schema 自愈 + 迁移。
 * - 库内版本**落后** → 先备份（仅此情形）→ 跑迁移回调 → 写新版本（迁移与版本写入同一事务）；
 * - 库内版本**持平** → 不备份、直接跑幂等 DDL（自愈），**不动版本**；
 * - 库内版本**领先**（降级旧二进制）→ 同持平处理，但往 stderr 留痕（红线「不许静默」）。
 *
 * 调用时机由 makeDb/makeRegistryDb 在**建表前**做（备份要在改动落盘前完成）。
 * @param sqlite 已打开的库句柄
 * @param file 库文件路径（":memory:" 跳过备份——测试内存库无文件）
 * @param applyDdl 幂等建表 + 存量迁移的回调（本库自己的 ensureSchema 主体）
 */
export function runSchemaGate(sqlite: Database.Database, file: string, applyDdl: () => void): void {
  const current = readSchemaVersion(sqlite);
  const isFile = file !== ":memory:";
  const needsMigrate = current < SCHEMA_VERSION;
  // 全新库（version 0 且无任何表）= 首次建库，无数据可备——不备份；只有「已有内容的老库」才在迁移前备份。
  const isLegacyWithData = needsMigrate && (current > 0 || hasAnyTable(sqlite));

  // 降级运行（旧二进制开新库，docs/11 回滚流程会遇到）：按设计自愈不迁，但红线「不许静默」——留痕。
  if (current > SCHEMA_VERSION) {
    process.stderr.write(
      `[schema] 库版本 ${current} 领先代码 ${SCHEMA_VERSION}（降级运行）：跑幂等自愈、不动版本（${file}）\n`,
    );
  }

  if (isLegacyWithData && isFile) {
    // 迁移前自动备份（仅在真要迁移时——正常启动零开销）。备份失败**中止迁移**（不回滚地改表更危险）。
    backupBeforeMigrate(sqlite, file, current);
  }
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
 *  备份失败抛错 → 中止迁移（不带着未备份的库改表）。 */
function backupBeforeMigrate(sqlite: Database.Database, file: string, fromVersion: number): void {
  // busy=1 = 有并发读者/写者令 TRUNCATE 未完成：主库文件尚缺已提交事务，此时拷出的「备份」会被
  // 当成回滚安全网——比没有备份更危险。直接抛错（与「备份失败中止迁移」同一底线：宁停不改）。
  const busy = sqlite.pragma("wal_checkpoint(TRUNCATE)", { simple: true });
  if (busy !== 0) {
    throw new Error(`迁移前备份失败：WAL checkpoint 未完成（busy）——中止迁移：${file}`);
  }
  const dir = path.join(path.dirname(file), "backup");
  mkdirSync(dir, { recursive: true });
  const base = path.basename(file, path.extname(file));
  // 北京时间戳（D-97 单出处 wallClockFromDate）；':' 在 Windows 文件名非法 → 换 '-'，与全库墙钟同形状可比
  const stamp = wallClockFromDate(new Date()).replace(/[:.]/g, "-"); // 2026-10-12T09-14-41
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
