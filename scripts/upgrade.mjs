// 升级 runbook 脚本化（批次 2 / docs/13 三）：备份 → 拉新镜像 → 重启触发迁移 → 健康检查。
// 用法（在服务器仓库根、装有 docker compose 的机器上）：node scripts/upgrade.mjs
// 依赖宿主机的 docker / docker compose 与 curl。回滚是人工决策（见 docs/13 三·5）——本脚本不自动回滚，
// 只在任一步失败时停下并打印回滚指引，把决定权留给人。
import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = path.join(root, "backups", stamp);

/** 跑一条命令（继承 stdio，失败抛错）。 */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

/** 打印某一步失败后的回滚指引（不自动回滚）。 */
function fail(step, err) {
  console.error(`\n✗ 升级在「${step}」失败：${err instanceof Error ? err.message : String(err)}`);
  console.error("→ 回滚指引见 docs/13 三·5：回退镜像 tag 后 docker compose up -d；库如需回退用备份覆盖（连 -wal/-shm 一并删）。");
  process.exit(1);
}

// ── 1. 备份（升级前，最重要）──
// 直接拷 data/ 下的 .db（应用未在写时点做；生产更稳是用 SQLite .backup API——docs/11 阶段 1）。
// 本脚本采用「停服后再拷」以保证一致性：先 down（数据落盘、WAL 随连接关闭 checkpoint）再拷。
try {
  if (!existsSync(dataDir)) throw new Error(`找不到数据目录：${dataDir}`);
  console.log("[1/4] 备份 data/…");
  // 停服，确保数据文件一致（WAL 在连接关闭时 checkpoint 回主库）
  run("docker", ["compose", "down"]);
  mkdirSync(backupDir, { recursive: true });
  for (const f of readdirSync(dataDir)) {
    if (f.endsWith(".db") || f.endsWith(".db-wal") || f.endsWith(".db-shm")) {
      cpSync(path.join(dataDir, f), path.join(backupDir, f));
    }
  }
  // 用户库目录（data/users/*.db）
  const usersDir = path.join(dataDir, "users");
  if (existsSync(usersDir)) {
    const usersBackup = path.join(backupDir, "users");
    mkdirSync(usersBackup, { recursive: true });
    for (const f of readdirSync(usersDir)) {
      if (f.endsWith(".db") || f.endsWith(".db-wal") || f.endsWith(".db-shm")) {
        cpSync(path.join(usersDir, f), path.join(usersBackup, f));
      }
    }
  }
  console.log(`  备份完成：${backupDir}`);
} catch (err) {
  fail("备份", err);
}

// ── 2. 拉新镜像 / 重建 ──
try {
  console.log("[2/4] 更新代码/镜像…");
  // 本地 build 形态：先拉代码（若这是 git 仓库）。ACR 形态：改 compose 的 image: 后 pull。
  run("docker", ["compose", "pull"], { stdio: "inherit" });
} catch {
  // pull 在本地 build 形态会失败（无 image:）——不致命，继续 build
  console.log("  （pull 跳过：本地 build 形态）");
}

// ── 3. 重启（触发 schema 版本门控迁移）──
try {
  console.log("[3/4] 重启（启动时逐库过版本门控）…");
  run("docker", ["compose", "up", "-d", "--build"]);
} catch (err) {
  fail("重启", err);
}

// ── 4. 健康检查 ──
try {
  console.log("[4/4] 健康检查…");
  run("docker", ["compose", "ps"]);
  console.log("→ 人工确认：容器 healthy、logs 无 [schema]/[space] 报错、登录看板数据在（docs/13 三·4）。");
  console.log("✓ 升级流程完成。若健康检查不过：按 docs/13 三·5 回滚。");
} catch (err) {
  fail("健康检查", err);
}
