import type Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// schema 迁移三件套（批次 2 / docs/11 阶段 2）：**版本号 + 迁移前自动备份 + 逐库跑**。
// 逐库跑：由调用方（index 启动遍历账户、每库 makeDb）天然保证——本模块只管单库的版本门控。
// 版本记录用 SQLite 内建 `PRAGMA user_version`（整数）：两库通用、零建表（用户库没有 meta 表）。
// 「仅向前」：回滚 = 恢复备份 + 回退镜像 tag（不写 down 迁移）。

/** 当前 schema 版本（**代码常量，唯一出处**）。改表结构时 +1，并在 migrateSteps 里补一步。 */
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
 * - 库内版本**落后** → 先备份（仅此情形）→ 跑迁移回调 → 写新版本；
 * - 库内版本**持平/领先**（领先=降级旧二进制）→ 不备份、直接跑幂等 DDL（自愈），**不动版本**。
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

  if (isLegacyWithData && isFile) {
    // 迁移前自动备份（仅在真要迁移时——正常启动零开销）。备份失败**中止迁移**（不回滚地改表更危险）。
    backupBeforeMigrate(sqlite, file, current);
  }
  applyDdl(); // 幂等建表 + 存量迁移（DDL 里 IF NOT EXISTS / 幂等 UPDATE 自愈老库）
  if (needsMigrate) writeSchemaVersion(sqlite, SCHEMA_VERSION);
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

/** 迁移前备份：`<dir>/backup/<名>-v<旧版本>-<时间戳>.db`。**同步**（不把 makeDb 变 async）：
 *  先 WAL checkpoint 把已提交内容落主库文件，再拷主库文件 + WAL/SHM（迁移发生在启动早期、无并发写，
 *  故这会得到一致快照）。保留最近 BACKUP_KEEP 份。备份失败抛错 → 中止启动（不带着未备份的库改表）。 */
function backupBeforeMigrate(sqlite: Database.Database, file: string, fromVersion: number): void {
  const dir = path.join(path.dirname(file), "backup");
  mkdirSync(dir, { recursive: true });
  sqlite.pragma("wal_checkpoint(TRUNCATE)"); // 已提交内容落主库文件（WAL 清空）——文件即完整快照
  const base = path.basename(file, path.extname(file));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-10-13T08-00-00
  const target = path.join(dir, `${base}-v${fromVersion}-${stamp}.db`);
  copyFileSync(file, target); // 主库文件（checkpoint 后含全部已提交数据）
  pruneBackups(dir, base);
}

/** 保留最近 BACKUP_KEEP 份 `<base>-*.db`，多余按修改时间从旧到新删。 */
function pruneBackups(dir: string, base: string): void {
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}-v`) && f.endsWith(".db"))
    .map((f) => ({ f, full: path.join(dir, f) }));
  if (mine.length <= BACKUP_KEEP) return;
  // 按 mtime 升序（旧在前），删到只剩 KEEP 份
  mine.sort((a, b) => statSync(a.full).mtimeMs - statSync(b.full).mtimeMs);
  for (const { full } of mine.slice(0, mine.length - BACKUP_KEEP)) {
    rmSync(full, { force: true });
  }
}

/** 从备份文件恢复（试恢复演练/事故回滚用；离线操作——须先停服）。 */
export function restoreFromBackup(backupFile: string, targetFile: string): void {
  if (!existsSync(backupFile)) throw new Error(`备份不存在：${backupFile}`);
  copyFileSync(backupFile, targetFile);
  // 顺手清目标库的 WAL/SHM（否则残留 WAL 会被当成最新——恢复须从干净基点起）
  for (const suffix of ["-wal", "-shm"]) rmSync(targetFile + suffix, { force: true });
}
