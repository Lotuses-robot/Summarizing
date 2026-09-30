// 数据库回档脚本：把 data/summarizing.db 恢复成空库（表结构完整）。
// 首次运行时在 data/backup/summarizing.empty.db 生成空库备份；之后回档 = 从该备份复制。
// 用法：npm run db:reset
import { existsSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { makeDb } from "../apps/server/src/storage/db";

const LIVE = "data/summarizing.db";
const BACKUP = "data/backup/summarizing.empty.db";
const SUFFIXES = ["", "-wal", "-shm"] as const;

if (!existsSync(BACKUP)) {
  mkdirSync("data/backup", { recursive: true });
  makeDb(BACKUP); // makeDb 幂等建表——备份永远与当前 schema 同源
  console.log("已生成空库备份:", BACKUP);
}

for (const suffix of SUFFIXES) {
  rmSync(LIVE + suffix, { force: true });
  const backupSide = BACKUP + suffix;
  if (existsSync(backupSide)) cpSync(backupSide, LIVE + suffix);
}
makeDb(LIVE); // 打开验证 + 完成初始化
console.log("已回档：data/summarizing.db = 空库（表结构完整，无数据）");
