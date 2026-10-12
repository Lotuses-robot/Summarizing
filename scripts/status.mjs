// 一屏诊断（docs/13 四）：容器状态 + 最近错误 + 磁盘 + 备份 + 版本——出错时敲一条看全。
// 用法（服务器仓库根）：node scripts/status.mjs  或  npm run status
// 只读、不改任何东西；任一子项取不到不致命（打印 "(取不到)" 继续），保证一屏总能出。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

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

// 2. 版本（当前镜像 tag）
console.log("\n[版本]");
const appImage = (process.env.APP_IMAGE ?? "").trim();
console.log(appImage !== "" ? `  镜像：${appImage}` : "  本地 build 形态（无 APP_IMAGE）");

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

// 5. 备份（data/backups/ 最近一次）
console.log("\n[备份]");
const backupsDir = path.join(dataDir, "backups");
if (!existsSync(backupsDir)) {
  console.log("  (无 data/backups/——还没跑过 backup，或备份在别处)");
} else {
  const dirs = readdirSync(backupsDir).sort();
  if (dirs.length === 0) console.log("  (空——无备份)");
  else {
    const latest = dirs[dirs.length - 1];
    const st = statSync(path.join(backupsDir, latest));
    console.log(`  最近：${latest}（${st.mtime.toISOString()}）`);
    console.log(`  共 ${dirs.length} 份：${dirs.slice(-5).join(", ")}`);
  }
}

console.log("\n提示：细节排查用 `docker compose logs -f app`；在线/告警看 Uptime Kuma（docs/13 五）。");
