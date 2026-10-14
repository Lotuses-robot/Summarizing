// 升级 runbook 脚本化（批次 2 / docs/13 三）：**查最新版 → 核对 ACR 已同步 → 备份 → 改 .env tag → 拉镜像 → 重启迁移 → 健康检查**。
// 用法（在服务器仓库根、装有 docker compose 的机器上）：node scripts/upgrade.mjs
// 依赖宿主机 docker / docker compose；查版本优先 gh，无 gh 回退 curl 公开 API（公开仓库免认证）；
// 两样都不可用/限流时可设 UPGRADE_TARGET=vX.Y.Z 手动指定目标（离线逃生口）。
// 回滚是人工决策（见 docs/13 三·5）——本脚本不自动回滚，只在任一步失败时停下并打印回滚指引。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDotEnv, writeAppImage } from "./lib/dotenv.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const REPO = "Lotuses-robot/Summarizing"; // 最新版本来源（GitHub Release = 发布源头）

/** 跑一条命令（继承 stdio，失败抛错）。 */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

/** 跑一条命令并回收 stdout（不继承 stdio；失败抛错）。maxBuffer 放宽到 16MiB（compose logs 可能很长）。 */
function capture(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/** 打印某一步失败后的回滚指引（不自动回滚）。 */
function fail(step, err) {
  console.error(`\n✗ 升级在「${step}」失败：${err instanceof Error ? err.message : String(err)}`);
  console.error("→ 回滚指引见 docs/13 三·5：回退镜像 tag 后 docker compose up -d；库如需回退用备份覆盖（连 -wal/-shm 一并删）。");
  process.exit(1);
}

const msgOf = (err) => (err instanceof Error ? err.message : String(err));

/** 从镜像 ref 取 tag（最后一个 ':' 之后且不含 '/'——防把 registry 端口号当 tag）。 */
function tagOf(ref) {
  const i = ref.lastIndexOf(":");
  if (i < 0) return "(无 tag)";
  const tail = ref.slice(i + 1);
  return tail === "" || tail.includes("/") ? "(无 tag)" : tail;
}

/** 取去掉 tag 的 base（无 tag 时原样返回），供拼目标 tag。 */
function baseOf(ref) {
  const i = ref.lastIndexOf(":");
  if (i < 0) return ref;
  return ref.slice(i + 1).includes("/") ? ref : ref.slice(0, i);
}

/** 解析 v主.次.修 → [n,n,n]；不合形状返回 null（如带 -rc 的预发版——不判）。 */
function parseTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** to 是否比 from 旧（防降级；任一边形不成语义化版本则不判）。 */
function isDowngrade(from, to) {
  const a = parseTag(from);
  const b = parseTag(to);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return b[i] < a[i];
  }
  return false;
}

/** 北京墙钟戳（备份目录名用）：固定 +08:00 偏移、与机器时区无关——与
 *  apps/server/src/shared/time.ts 的 wallClockFromDate 同一算法（D-97 口径；脚本不 import TS 源码，照此对齐）。 */
function beijingStamp() {
  const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}-${p(shifted.getUTCMinutes())}-${p(shifted.getUTCSeconds())}`
  );
}

// ── 0. 版本核对（ACR 形态）：当前 = **在跑容器的镜像**（查不到才回退 .env 声明）→ 目标 = 最新 release ──
// 形态判断：.env 设了 APP_IMAGE（ACR 形态）才算得出「当前版本」；本地 build 形态无 tag 可比，跳过核对。
const env = readDotEnv(root);
const appImage = (process.env.APP_IMAGE ?? env.vars.APP_IMAGE ?? "").trim();
const useImage = appImage !== "";
let targetRef = ""; // ACR 形态的目标镜像 ref（步骤 2 改写 .env 用）

if (useImage) {
  // 当前版本以「实际在跑的容器」为准——.env 可能已先被改过或 pull 还没做（审查 2026-10-14：
  // 曾直接读 .env，会把「.env 已改但没升级」误判成已最新而提前退出）。
  let liveRef = appImage;
  let liveFrom = ".env 声明（未找到在跑的 app 容器）";
  try {
    const id = capture("docker", ["compose", "ps", "-q", "app"]);
    if (id !== "") {
      const insp = capture("docker", ["inspect", "--format", "{{.Config.Image}}", id.split("\n")[0]]);
      if (insp !== "") {
        liveRef = insp;
        liveFrom = "在跑容器";
      }
    }
  } catch {
    // docker/compose 不可用 → 回退 .env 声明值（后续步骤自会报错，这里不拦）
  }
  const currentTag = tagOf(liveRef);

  // 目标版本：UPGRADE_TARGET 显式指定 > gh（带凭据、限流宽）> curl 公开 API（公开仓库免认证）。
  let latestTag = (process.env.UPGRADE_TARGET ?? "").trim();
  if (latestTag === "") {
    try {
      latestTag = capture("gh", ["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]);
      if (latestTag === "") throw new Error("gh 返回空 tag");
    } catch (ghErr) {
      try {
        const body = capture("curl", [
          "-fsSL",
          "-H",
          "accept: application/vnd.github+json",
          `https://api.github.com/repos/${REPO}/releases/latest`,
        ]);
        const parsed = JSON.parse(body);
        latestTag = typeof parsed?.tag_name === "string" ? parsed.tag_name : "";
        // 附 cause：这是 catch(ghErr) 内抛出的新错（原因链不断——gh 的失败在错误消息里已带上）
        if (latestTag === "") throw new Error("响应里没有 tag_name", { cause: ghErr });
      } catch (curlErr) {
        fail(
          "查 GitHub 最新版",
          new Error(
            `gh 与 curl 公开 API 都不可用（gh：${msgOf(ghErr)}；curl：${msgOf(curlErr)}）——` +
              "可设 UPGRADE_TARGET=vX.Y.Z 手动指定目标版本",
          ),
        );
      }
    }
  }
  console.log(`[0/5] 版本核对：当前 ${currentTag}（${liveFrom}）→ 目标 ${latestTag}`);
  if (latestTag === currentTag) {
    console.log("  已是最新，无需升级。");
    process.exit(0);
  }
  if (isDowngrade(currentTag, latestTag)) {
    console.error(`\n✗ 目标 ${latestTag} 比当前 ${currentTag} 旧——拒绝降级（防止误把线上打回旧版）。`);
    console.error("  如确要回退：手动改 .env 的 APP_IMAGE 为旧 tag，再 docker compose pull && docker compose up -d（docs/13 三·5）。");
    process.exit(1);
  }
  // **ACR 同步检查（关键）**：CI 可能还没把新 tag 推到 ACR——此时升级会拉到旧/不存在的镜像。
  // docker manifest inspect 走 docker login 凭据（无需额外 AccessKey）。
  // ⚠️ 局限：未登录 ACR 与 tag 不存在，docker 都报 "denied/unauthorized"（实测两者同形）——故这里
  // 只能判「能否取到该 manifest」；取不到即拒绝（宁可停下让人确认，也不冒拉到旧镜像的险）。
  targetRef = `${baseOf(liveRef)}:${latestTag}`;
  let inspectErr = "";
  const synced = (() => {
    try {
      capture("docker", ["manifest", "inspect", targetRef]);
      return true;
    } catch (e) {
      inspectErr = String(e.stderr ?? e.message ?? "").trim();
      return false;
    }
  })();
  if (!synced) {
    console.error(`\n✗ 无法确认 ACR 已有 ${latestTag}（${targetRef}）。显式拒绝升级。`);
    console.error(`  两种可能，逐一排查：`);
    console.error(`   ① CI 还没推完镜像（GitHub Actions 的 image job 未绿）：gh run list -R ${REPO} --limit 3`);
    console.error(`   ② 服务器未登录 ACR（凭据过期也会这样）：docker login ${baseOf(liveRef).split("/")[0]}`);
    console.error(`  docker 报错原文：${inspectErr.split("\n").slice(0, 2).join(" / ")}`);
    process.exit(1);
  }
  console.log(`  ✓ ACR 已有 ${latestTag}，继续升级。`);
}

// ── 1. 备份（升级前，最重要）──
// 用容器内的 admin backup 走 SQLite .backup API（在线热备、WAL 安全、不停服）——R12-6。
// 落点 = 宿主 ./data/backups/pre-upgrade-<北京戳>/（compose 把 ./data 挂进容器 = /app/data；
// 备份必须落在挂载点内才留得住——戳由本脚本算好显式传入，不赌容器内 admin 的默认路径，审查 2026-10-14）。
const backupDir = `pre-upgrade-${beijingStamp()}`;
try {
  if (!existsSync(dataDir)) throw new Error(`找不到数据目录：${dataDir}`);
  console.log(`[1/5] 在线备份 data/ → data/backups/${backupDir}/…（SQLite .backup API）`);
  run("docker", [
    "compose",
    "exec",
    "-T",
    "app",
    "node",
    "apps/server/dist/admin.mjs",
    "backup",
    "--out",
    `/app/data/backups/${backupDir}`,
  ]);
  console.log(`  备份完成：${path.join(dataDir, "backups", backupDir)}`);
} catch (err) {
  fail("备份", err);
}

// ── 2. 改 .env 到目标 tag + 拉新镜像 /（本地 build 形态）拉代码 ──
// ACR 形态：升级 = compose 拉「目标 tag」的镜像——不把 .env 的 APP_IMAGE 改到新 tag，
// pull/up 拿到的还是旧 tag（旧行为曾「pull 完旧镜像重启、脚本却报升级成功」——审查 2026-10-14）。
try {
  if (useImage) {
    console.log(`[2/5] .env：APP_IMAGE → ${targetRef}；拉新镜像…`);
    writeAppImage(env, targetRef);
    run("docker", ["compose", "pull", "app"], { stdio: "inherit" });
  } else {
    // 本地 build 形态：git pull 失败**不吞**（审查 2026-10-14：曾连网络失败也打印「跳过」，
    // 静默继续到 build+健康检查全绿 = 假升级）；只有「本来就不是 git 工作区」才允许跳过。
    let isGit = false;
    try {
      capture("git", ["rev-parse", "--is-inside-work-tree"]);
      isGit = true;
    } catch {
      isGit = false;
    }
    if (isGit) {
      console.log("[2/5] 更新代码（本地 build 形态：git pull）…");
      run("git", ["pull", "--ff-only"], { stdio: "inherit" });
    } else {
      console.log("[2/5] 非 git 工作区——跳过代码更新（若是便携包形态，请手动替换新包）");
    }
  }
} catch (err) {
  fail("改 .env / 拉新镜像或代码", err);
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
// 判据：①容器起来后等 /api/board 回 401（受保护面未登录应答 = 服务活着）
//      ②最近日志无 [schema] 报错（迁移异常/降级运行）与 [space] 装配失败。
// ⚠️ 「[space] AI 客户端构造失败，按未配置处理」是**正常启动信息**（配置坏账户照常起服务），不算失败。
// 任一不过 → 打印回滚指引、非零退出（CI/cron 里跑也能感知成败）。
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
  // 查最近日志有无致命错（--tail 防把历史启动的旧错当本次失败；日志量大也不怕，capture 已放宽 maxBuffer）
  const logs = capture("docker", ["compose", "logs", "--tail", "500", "app"]);
  const bad = logs
    .split("\n")
    .filter((l) => l.includes("[schema]") || (l.includes("[space]") && l.includes("装配失败")));
  if (bad.length > 0) {
    throw new Error(`日志出现 ${bad.length} 条 [schema]/[space] 装配失败报错：\n${bad.slice(-5).join("\n")}`);
  }
  console.log("  ✓ 服务就绪（/api/board 401）、日志无 [schema]/[space] 装配失败报错。");
  console.log("✓ 升级成功。若数据异常：按 docs/13 三·5 回滚（恢复备份 + 回退镜像 tag）。");
  console.log(`  本次升级前备份：data/backups/${backupDir}/`);
} catch (err) {
  fail("健康检查", err);
}
