// 升级 runbook 脚本化（批次 2 / docs/13 三）：**查最新版 → 核对 ACR 已同步 → 备份 → 拉镜像 → 重启迁移 → 健康检查**。
// 用法（在服务器仓库根、装有 docker compose 的机器上）：node scripts/upgrade.mjs
// 依赖宿主机 docker / docker compose，以及 `gh`（查 GitHub 最新 release；无 gh 时回退公开 API 需 curl）。
// 回滚是人工决策（见 docs/13 三·5）——本脚本不自动回滚，只在任一步失败时停下并打印回滚指引。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const REPO = "Lotuses-robot/Summarizing"; // 最新版本来源（GitHub Release = 发布源头）

/** 跑一条命令（继承 stdio，失败抛错）。 */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

/** 跑一条命令并回收 stdout（不继承 stdio；失败抛错）。 */
function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
}

/** 打印某一步失败后的回滚指引（不自动回滚）。 */
function fail(step, err) {
  console.error(`\n✗ 升级在「${step}」失败：${err instanceof Error ? err.message : String(err)}`);
  console.error("→ 回滚指引见 docs/13 三·5：回退镜像 tag 后 docker compose up -d；库如需回退用备份覆盖（连 -wal/-shm 一并删）。");
  process.exit(1);
}

// ── 0. 版本核对：查最新版 → 比对当前 → **确认 ACR 已有该镜像**（未同步则显式拒绝）──
// 形态判断：.env 设了 APP_IMAGE（ACR 形态）才算得出「当前版本」；本地 build 形态无 tag 可比，跳过核对。
const appImage = (process.env.APP_IMAGE ?? "").trim();
if (appImage !== "") {
  const currentTag = appImage.includes(":") ? appImage.slice(appImage.lastIndexOf(":") + 1) : "(无 tag)";
  let latestTag = "";
  try {
    latestTag = capture("gh", ["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]);
  } catch {
    fail("查 GitHub 最新版", new Error("`gh` 不可用或查询失败——先装 gh 并 `gh auth login`，或手动确认最新版"));
  }
  console.log(`[0/5] 版本核对：当前 ${currentTag} → 最新 ${latestTag}`);
  if (latestTag === currentTag) {
    console.log(`  已是最新（${currentTag}），无需升级。`);
    process.exit(0);
  }
  // **ACR 同步检查（关键）**：CI 可能还没把新 tag 推到 ACR——此时升级会拉到旧/不存在的镜像。
  // docker manifest inspect 走 docker login 凭据（无需额外 AccessKey）。
  // ⚠️ 局限：未登录 ACR 与 tag 不存在，docker 都报 "denied/unauthorized"（实测两者同形）——故这里
  // 只能判「能否取到该 manifest」；取不到即拒绝（宁可停下让人确认，也不冒拉到旧镜像的险）。
  const acrRef = `${appImage.slice(0, appImage.lastIndexOf(":"))}:${latestTag}`; // 换 tag，保留 registry/ns/repo
  let inspectErr = "";
  const synced = (() => {
    try {
      capture("docker", ["manifest", "inspect", acrRef]);
      return true;
    } catch (e) {
      inspectErr = String(e.stderr ?? e.message ?? "").trim();
      return false;
    }
  })();
  if (!synced) {
    console.error(`\n✗ 无法确认 ACR 已有 ${latestTag}（${acrRef}）。显式拒绝升级。`);
    console.error(`  两种可能，逐一排查：`);
    console.error(`   ① CI 还没推完镜像（GitHub Actions 的 image job 未绿）：gh run list -R ${REPO} --limit 3`);
    console.error(`   ② 服务器未登录 ACR（凭据过期也会这样）：docker login ${appImage.slice(0, appImage.indexOf("/"))}`);
    console.error(`  docker 报错原文：${inspectErr.split("\n").slice(0, 2).join(" / ")}`);
    process.exit(1);
  }
  console.log(`  ✓ ACR 已有 ${latestTag}，继续升级。`);
}

// ── 1. 备份（升级前，最重要）──
// 用容器内的 admin backup 命令走 SQLite .backup API（在线热备、WAL 安全、不停服）——R12-6。
// 备份落在宿主机 backups/<戳>/（compose 把 ./data 挂进容器，backups 落在仓库根同级，见 admin 命令默认路径）。
try {
  if (!existsSync(dataDir)) throw new Error(`找不到数据目录：${dataDir}`);
  console.log("[1/5] 在线备份 data/…（SQLite .backup API）");
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
    console.log(`[2/5] 拉新镜像 ${process.env.APP_IMAGE}…`);
    run("docker", ["compose", "pull", "app"], { stdio: "inherit" });
  } else {
    console.log("[2/5] 更新代码（本地 build 形态：git pull）…");
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
  console.log("[3/5] 重启（启动时逐库过版本门控）…");
  // ACR 形态：只起（--no-build，用刚 pull 的镜像）；本地 build 形态：构建后起
  run("docker", ["compose", "up", "-d", ...(useImage ? ["--no-build"] : ["--build"])]);
} catch (err) {
  fail("重启", err);
}

// ── 4. 健康检查（**真判**：起得来 + 日志无致命错）──
// 判据：①容器起来后等 /api/board 回 401（受保护面未登录应答 = 服务活着）②容器日志无 [schema]/[space] 报错
//（迁移失败/账户装配失败都在这两行）。任一不过 → 打印回滚指引、非零退出（CI/cron 里跑也能感知成败）。
try {
  console.log("[4/5] 健康检查（起服务 + 查日志）…");
  // 等容器就绪（最多 ~30s：轮询 /api/board 应得 401）
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      // 走容器内端口探测（宿主 3001 未映射，容器内 3001 即应用）；curl 在 node:22-slim 里没有，用 node fetch
      run("docker", [
        "compose",
        "exec",
        "-T",
        "app",
        "node",
        "-e",
        "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/board').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))",
      ]);
      healthy = true;
      break;
    } catch {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]); // 等 3s 再试
    }
  }
  if (!healthy) throw new Error("容器 30s 内未就绪（/api/board 未回 401）");
  // 查日志有无致命错
  const logs = capture("docker", ["compose", "logs", "app"]);
  const bad = logs.split("\n").filter((l) => /\[schema\]|\[space\]/.test(l));
  if (bad.length > 0) {
    throw new Error(`日志出现 ${bad.length} 条 [schema]/[space] 报错：\n${bad.slice(-5).join("\n")}`);
  }
  console.log("  ✓ 服务就绪（/api/board 401）、日志无 [schema]/[space] 报错。");
  console.log("✓ 升级成功。若数据异常：按 docs/13 三·5 回滚（恢复备份 + 回退镜像 tag）。");
} catch (err) {
  fail("健康检查", err);
}
