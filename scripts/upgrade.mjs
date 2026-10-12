// 升级 runbook 脚本化（批次 2 / docs/13 三）：备份 → 拉新镜像 → 重启触发迁移 → 健康检查。
// 用法（在服务器仓库根、装有 docker compose 的机器上）：node scripts/upgrade.mjs
// 依赖宿主机的 docker / docker compose 与 curl。回滚是人工决策（见 docs/13 三·5）——本脚本不自动回滚，
// 只在任一步失败时停下并打印回滚指引，把决定权留给人。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

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
// 用容器内的 admin backup 命令走 SQLite .backup API（在线热备、WAL 安全、不停服）——R12-6。
// 备份落在宿主机 backups/<戳>/（compose 把 ./data 挂进容器，backups 落在仓库根同级，见 admin 命令默认路径）。
try {
  if (!existsSync(dataDir)) throw new Error(`找不到数据目录：${dataDir}`);
  console.log("[1/4] 在线备份 data/…（SQLite .backup API）");
  // admin 命令在容器内跑；--out 指到容器内可见的路径（compose 只挂了 ./data，故备份先落 data 同级需另挂——
  // 这里直接备到 /app/data/backups/，宿主对应 ./data/backups/，属主与 data 同）
  run("docker", [
    "compose",
    "exec",
    "-T",
    "app",
    "node",
    "apps/server/dist/admin.mjs",
    "backup",
    "--out",
    "/app/data/backups",
  ]);
  console.log("  备份完成：<repo>/data/backups/");
} catch (err) {
  fail("备份", err);
}

// ── 2. 拉新镜像 / 重建 ──
// 形态决定动作：.env 设了 APP_IMAGE（ACR 形态）→ pull 拉新镜像；否则（本地 build 形态）→ 拉代码后 build。
const useImage = (process.env.APP_IMAGE ?? "").trim() !== "";
try {
  if (useImage) {
    console.log(`[2/4] 拉新镜像 ${process.env.APP_IMAGE}…`);
    run("docker", ["compose", "pull", "app"], { stdio: "inherit" });
  } else {
    console.log("[2/4] 更新代码（本地 build 形态：git pull）…");
    try {
      run("git", ["pull", "--ff-only"], { stdio: "inherit" });
    } catch {
      console.log("  （git pull 跳过：非 git 工作区或已最新）");
    }
  }
} catch (err) {
  fail("拉新镜像/代码", err);
}

// ── 3. 重启（触发 schema 版本门控迁移）──
try {
  console.log("[3/4] 重启（启动时逐库过版本门控）…");
  // ACR 形态：只起（--no-build，用刚 pull 的镜像）；本地 build 形态：构建后起
  run("docker", ["compose", "up", "-d", ...(useImage ? ["--no-build"] : ["--build"])]);
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
