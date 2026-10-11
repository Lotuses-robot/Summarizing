// 发布包构建：免安装 Windows zip（内置 node.exe，解压双击即跑）。
// 用法：npm run build:release [-- --skip-web]（--skip-web 复用已有前端构建）
// 结构保持与仓库同层深（apps/server/dist、apps/web/dist、node_modules/、data/）——
// dotenv 与 dataFile 的 `../../..` 根路径解析零改动直接生效。
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "release");
const zipName = "summarizing-portable-win-x64.zip";
const zipPath = path.join(root, zipName);

if (process.platform !== "win32") {
  console.error("本脚本当前只构建 Windows 便携包（win32-x64）；其它平台见 TODO。");
  process.exit(1);
}

const skipWeb = process.argv.includes("--skip-web");

const START_CMD = `@echo off
cd /d "%~dp0"
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [summarizing] created .env - open it and fill in your OpenAI-compatible API settings.
)
rem Fast path: user data dir exists = already set up (skip the extra node probe on every start)
if exist "data\\users" goto :start_server
set ACC_COUNT=1
for /f %%c in ('".\\node\\node.exe" "apps\\server\\dist\\admin.mjs" count:accounts') do set ACC_COUNT=%%c
if not "%ACC_COUNT%"=="0" goto :start_server
echo [summarizing] First run - create your account now ^(you will log in with it^).
".\\node\\node.exe" "apps\\server\\dist\\admin.mjs" user:add
if errorlevel 1 (
  echo [summarizing] Account setup not completed. Run this first, then start again:
  echo   node apps\\server\\dist\\admin.mjs user:add
  pause
  exit /b 1
)
:start_server
start /min "" cmd /c "timeout /t 2 /nobreak >nul & explorer http://localhost:3001"
".\\node\\node.exe" "apps\\server\\dist\\index.mjs"
pause
`;

const README_TXT = `Summarizing · 便携版（Windows）
================================

一、第一次使用
  1. 打开本文件夹里的 .env（首次启动会自动生成），填入你的 AI 接入：
       OPENAI_BASE_URL=...   （OpenAI 兼容接口，须带 /v1）
       OPENAI_MODEL=...
       OPENAI_API_KEY=...
  2. 双击 start.cmd —— 首次会引导你创建自己的账户（用户名 + 密码）。
  3. 之后在浏览器里登录使用。

二、之后每次
  双击 start.cmd。浏览器会自动打开 http://localhost:3001
  黑色窗口 = 服务本体，别关；关闭窗口即停止。

三、数据在哪
  data\\ 文件夹——system.db（账户登记）+ users\\<uid>.db（每人一个库）。
  整目录拷走即备份；删掉即重来。

四、试一下
  在右侧对话里丢一句「10月8日前交数据结构作业」，看它变成看板上的一条事项。
  （不配 AI 也能打开界面，只是没法消化信息。）

五、运维命令（可选）
  建账户 / 发邀请码 / 停用账户等一律走命令行：
    node apps\\server\\dist\\admin.mjs user:add 你的名字
    node apps\\server\\dist\\admin.mjs invite:new        （生成一次性邀请码）
    node apps\\server\\dist\\admin.mjs user:list          （列出账户，含 uid）
  完整用法：node apps\\server\\dist\\admin.mjs

六、从旧版（v0.1）升级？
  旧数据是 data\\summarizing.db（单一库）；新版每人一个库 data\\users\\<uid>.db。
  迁移步骤（先关掉服务）：
    1) node apps\\server\\dist\\admin.mjs user:add 你的名字
    2) node apps\\server\\dist\\admin.mjs user:list   → 抄下你的 uid
    3) 把旧 data\\summarizing.db 复制为 data\\users\\<uid>.db
    4) 重新 start.cmd，登录后数据就都在了。

七、端口
  默认 3001；被占用时可在启动前设置环境变量 PORT。
`;

// ── 1. 前端构建（vite）──
if (!skipWeb) {
  console.log("[1/4] 构建前端…");
  // execSync（走 shell）：Node 22+ 对 .cmd 直接 spawn 会 EINVAL（CVE 修复后的行为）
  execSync("npm run build -w @summarizing/web", { cwd: root, stdio: "inherit" });
} else {
  console.log("[1/4] 跳过前端构建（--skip-web）");
}
if (!existsSync(path.join(root, "apps/web/dist/index.html"))) {
  throw new Error("apps/web/dist 不存在——先去构建前端（或不要用 --skip-web）");
}

// ── 2. 服务端打包（esbuild 单文件；better-sqlite3 是原生模块，外挂）──
console.log("[2/4] 打包服务端…");
rmSync(out, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(root, "apps/server/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(out, "apps/server/dist/index.mjs"),
  external: ["better-sqlite3"],
  logLevel: "warning",
  // CJS 依赖（fastify 生态）在 ESM 产物里的 require 垫片：定义真 require，否则动态 require 抛错
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
});

// 运维命令入口（admin.mjs；start.cmd 首启引导 + 手动运维——同一份 scripts/admin.ts）
await esbuild.build({
  entryPoints: [path.join(root, "scripts/admin.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(out, "apps/server/dist/admin.mjs"),
  external: ["better-sqlite3"],
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
});

// ── 3. 组装目录 ──
console.log("[3/4] 组装…");
cpSync(path.join(root, "apps/web/dist"), path.join(out, "apps/web/dist"), { recursive: true });

// better-sqlite3 精简拷贝：package.json + lib/ + 本平台预编译 .node（约 2MB）
const bs3src = path.join(root, "node_modules/better-sqlite3");
const bs3dst = path.join(out, "node_modules/better-sqlite3");
mkPath(bs3dst);
cpSync(path.join(bs3src, "package.json"), path.join(bs3dst, "package.json"));
cpSync(path.join(bs3src, "lib"), path.join(bs3dst, "lib"), { recursive: true });
mkPath(path.join(bs3dst, "prebuilds"));
cpSync(
  path.join(bs3src, "prebuilds/win32-x64.node"),
  path.join(bs3dst, "prebuilds/win32-x64.node"),
);

// 运行时与杂项
mkPath(path.join(out, "node"));
cpSync(process.execPath, path.join(out, "node/node.exe")); // 内置 Node（免安装）
cpSync(path.join(root, ".env.example"), path.join(out, ".env.example"));
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));
cpSync(path.join(root, "LICENSE"), path.join(out, "LICENSE")); // AGPL 分发需随附
mkPath(path.join(out, "data")); // better-sqlite3 不建目录——留给首次运行

writeFileSync(path.join(out, "start.cmd"), START_CMD.replace(/\n/g, "\r\n"));
writeFileSync(path.join(out, "说明.txt"), README_TXT.replace(/\n/g, "\r\n"));

// ── 4. 压缩 ──
console.log("[4/4] 压缩…");
if (existsSync(zipPath)) rmSync(zipPath);
execFileSync("powershell", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path '${path.join(out, "*")}' -DestinationPath '${zipPath}' -Force`,
]);

const mb = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`完成：${zipPath}（${mb(zipPath)}）`);
console.log(`目录形态也在：${out}`);

/** 递归建目录（简写）。 */
function mkPath(p) {
  mkdirSync(p, { recursive: true });
}

