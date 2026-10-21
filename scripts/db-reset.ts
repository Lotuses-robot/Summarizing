// 数据库回档脚本：把多用户数据恢复成空（系统库重建 + 用户库清空）。
// 旧单机库 data/summarizing.db **不动**（D5 不做收编——要导走 manual 流程见 specs/006 quickstart 附录）。
// 用法：npm run db:reset
import { rmSync } from "node:fs";
import path from "node:path";
import { makeRegistryDb } from "../apps/server/src/storage/registry";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const REGISTRY = path.join(DATA, "system.db");
const SUFFIXES = ["", "-wal", "-shm"] as const;

for (const suffix of SUFFIXES) rmSync(REGISTRY + suffix, { force: true });
rmSync(path.join(DATA, "users"), { recursive: true, force: true });
// 图片字节（009）随账户一起清——否则旧 uid 的目录成了永远不会被再引用的孤儿
rmSync(path.join(DATA, "media"), { recursive: true, force: true });
// 迁移备份一并清（system-v*.db 含账户凭据与 webhook 令牌——「清空」必须清干净，评审修复）
rmSync(path.join(DATA, "backup"), { recursive: true, force: true });
makeRegistryDb(REGISTRY); // 重建 + 验证（幂等建表；session_secret 重新播种）
console.log("已回档：data/system.db 重建为空（账户清空、users/ 与 backup/ 已删）");
console.log("下一步：npm run admin -- user:add <你的用户名> 建账户");
