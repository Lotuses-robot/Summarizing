// 一屏诊断（docs/13 四）：容器状态 + 最近错误 + 磁盘 + 备份 + 版本——出错时敲一条看全。
// 用法（服务器仓库根）：node scripts/status.mjs  或  npm run status
// 只读、不改任何东西；任一子项取不到不致命（打印 "(取不到)" 继续），保证一屏总能出。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDotEnv } from "./lib/dotenv.mjs";
import { liveAppImageRef } from "./lib/docker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const dotenv = readDotEnv(root); // .env 我们自己读（node 不自动加载；compose 才认识 .env）

/** 跑一条命令取 stdout（失败返回 null，不抛——诊断脚本要能容错继续）。 */
function cap(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

console.log("═══ summarizing 状态 ═══");

// 1. 容器状态
console.log("\n[容器]");
const ps = cap("docker", ["compose", "ps", "--format", "table {{.Service}}\t{{.Status}}"]);
console.log(ps ?? "  (取不到——docker compose 不可用？)");

// 2. 版本（在跑容器的镜像 tag；.env 声明值并列显示——两者不一致说明改过没 pull/up）
// 部署声明只认 .env（与 upgrade.mjs 同口径——曾读 shell 值却标成「.env 声明」，与升级脚本各执一词，审查 2026-10-14）
console.log("\n[版本]");
const appImage = (dotenv.vars.APP_IMAGE ?? "").trim();
const live = liveAppImageRef(root);
const liveImage = "ref" in live ? live.ref : null;
console.log(
  `  在跑镜像：${
    liveImage ??
    (live.problem === "docker-unavailable" ? "(取不到——docker/compose 不可用)" : "(app 容器未运行)")
  }`,
);
console.log(appImage !== "" ? `  .env 声明：${appImage}` : "  .env 无 APP_IMAGE（本地 build 形态）");
if (liveImage !== null && appImage !== "" && liveImage !== appImage) {
  console.log("  ⚠️ 两者不一致——.env 改过但还没 pull/up，或手动改过 compose 环境");
}

// 3. 最近错误（从 app 日志 grep 关键前缀）
console.log("\n[最近错误（app 日志尾部）]");
const logs = cap("docker", ["compose", "logs", "--tail", "200", "app"]);
if (logs === null) {
  console.log("  (取不到——app 容器未运行？)");
} else {
  const bad = logs.split("\n").filter((l) => /\[error\]|\[schema\]|\[space\]|\[shutdown\]|Error|error/i.test(l));
  if (bad.length === 0) console.log("  ✓ 无 error/[schema]/[space] 行");
  else for (const l of bad.slice(-15)) console.log("  " + l);
}

// 4. 磁盘（宿主机）
console.log("\n[磁盘]");
const df = cap("df", ["-h", dataDir]);
if (df !== null) console.log("  " + df.split("\n").join("\n  "));
const dataSize = (() => {
  try {
    // 粗略统计 data/ 大小（不递归进 node_modules——data 下只有 .db）
    let bytes = 0;
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else bytes += st.size;
      }
    };
    if (existsSync(dataDir)) walk(dataDir);
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  } catch {
    return "(取不到)";
  }
})();
console.log(`  data/ 合计：${dataSize}`);

// 5. 备份（data/backups/：admin backup 的戳目录 + 兼容旧版平铺文件）
console.log("\n[备份]");
try {
  const backupsDir = path.join(dataDir, "backups");
  if (!existsSync(backupsDir)) {
    console.log("  (无 data/backups/——还没跑过 backup，或备份在别处)");
  } else {
    const entries = readdirSync(backupsDir, { withFileTypes: true }); // 类型随目录一并取，省 2N 次 stat
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const flat = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
    if (dirs.length === 0 && flat.length === 0) {
      console.log("  (空——无备份)");
    } else {
      if (dirs.length > 0) {
        console.log(`  最近：${dirs[dirs.length - 1]}/（共 ${dirs.length} 份：${dirs.slice(-5).join(", ")}）`);
      }
      if (flat.length > 0) {
        // 旧版 backup --out 直落文件的形态（每次覆盖同名）——提醒别把它当多份备份
        console.log(`  平铺文件 ${flat.length} 个（旧形态，会互相覆盖）：${flat.slice(0, 5).join(", ")}`);
      }
    }
  }
} catch {
  console.log("  (取不到——data/backups/ 读取失败)");
}

console.log("\n提示：细节排查用 `docker compose logs -f app`；在线/告警看 Uptime Kuma（docs/13 五）。");
