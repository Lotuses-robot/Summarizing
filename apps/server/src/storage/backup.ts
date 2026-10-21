import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// 备份/恢复（批次 2 / docs/11 阶段 1 + R12-6 + docs/13）：**在线热备份**走 SQLite `.backup` API。
// 与 migrate.ts 的「迁移前备份」分工：
//  - 迁移前备份（同步 checkpoint+拷贝）：跑在启动早期、无并发写者，同步即安全（见 migrate.ts 注释）——不改。
//  - 本模块（异步 .backup API）：服务运行中、用户可能在写——必须用在线备份，否则拷到撕裂态（R12 针对的场景）。

/** 数据根（含 system.db 与 users/<uid>.db）——006 库布局。 */
export interface DataLayout {
  dataRoot: string;
}

/**
 * 在线备份单个库到 dest（SQLite `.backup` API——WAL 安全、不停服、可并发读写）。
 * 目录不存在自建；同名已存在则覆盖（.backup 语义即写一份新的一致快照）。
 * @param file 源库路径（":memory:" 不支持——在线备份针对文件库）
 * @param dest 备份目标路径
 */
export async function backupDatabase(file: string, dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
}

/** 从备份文件恢复单个库（覆盖 target + 清 WAL/SHM 残留）。**离线操作——必须先停服**（目标库无活动连接，
 *  否则覆盖会被打开它的进程覆盖回去、且残留 WAL 会被当成最新）。目标目录不存在自建。 */
export function restoreDatabase(backupFile: string, target: string): void {
  if (!existsSync(backupFile)) throw new Error(`备份不存在：${backupFile}`);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(backupFile, target);
  // 清目标库的 WAL/SHM：残留 WAL 会在下次打开时被回放，把「恢复出的旧快照」污染成恢复点之后的状态
  for (const suffix of ["-wal", "-shm"]) rmSync(target + suffix, { force: true });
}

/** 数据根下全部库的相对路径（system.db + users/*.db；不存在的跳过）。备份与恢复共用同一份清单出处。 */
function listDbRelPaths(dataRoot: string): string[] {
  const rels: string[] = [];
  if (existsSync(path.join(dataRoot, "system.db"))) rels.push("system.db");
  const usersDir = path.join(dataRoot, "users");
  if (existsSync(usersDir)) {
    for (const f of readdirSync(usersDir)) {
      if (f.endsWith(".db")) rels.push(path.join("users", f));
    }
  }
  return rels;
}

/**
 * 备份数据根下全部库到 outDir（保留相对结构：outDir/system.db、outDir/users/<uid>.db）。
 * **图片字节也一起备**（009）：只备库不备 `media/`，还原后每张图都成了「已过期」（行在文件不在）。
 * 逐库 .backup；图片整目录拷贝（内容寻址只增，备份期间新增的图最多漏拷，不会产生坏文件）。
 * 返回备份出的条目（库的相对路径 + `media/` 标记）。
 */
export async function backupAll(layout: DataLayout, outDir: string): Promise<string[]> {
  const rels = listDbRelPaths(layout.dataRoot);
  for (const rel of rels) {
    await backupDatabase(path.join(layout.dataRoot, rel), path.join(outDir, rel));
  }
  if (existsSync(mediaRoot(layout.dataRoot))) {
    cpSync(mediaRoot(layout.dataRoot), path.join(outDir, "media"), { recursive: true });
    rels.push("media/");
  }
  return rels;
}

/** 把 inDir 里的全部库还原回数据根（system.db + users/<uid>.db），媒体目录同快照一并替换。
 *  **离线**（停服后）。返回还原的条目清单。 */
export function restoreAll(layout: DataLayout, inDir: string): string[] {
  const rels = listDbRelPaths(inDir);
  for (const rel of rels) {
    restoreDatabase(path.join(inDir, rel), path.join(layout.dataRoot, rel));
  }
  const mediaSrc = path.join(inDir, "media");
  if (existsSync(mediaSrc)) {
    // 与库同一份快照：先清再铺（否则会留下「库已回滚、文件还在」的幽灵图）
    const mediaDst = mediaRoot(layout.dataRoot);
    rmSync(mediaDst, { recursive: true, force: true });
    cpSync(mediaSrc, mediaDst, { recursive: true });
    rels.push("media/");
  }
  return rels;
}

/** 图片字节根（`<dataRoot>/media/<uid>/`）——与库同属一份备份快照。 */
function mediaRoot(dataRoot: string): string {
  return path.join(dataRoot, "media");
}
