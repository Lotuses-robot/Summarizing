// 服务端单文件打包单出处：esbuild 把 server 入口与 admin CLI 各打成自包含 .mjs，
// 只外挂原生模块（better-sqlite3 / sharp，运行时从 node_modules 加载）。build-release（便携包）与
// Dockerfile 共用——避免「入口清单 / --external / require 垫片」在两条产线上各写一份而静默漂移。
// 用法：node scripts/build-server.mjs <outDir>
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const outDir = process.argv[2];
if (!outDir) {
  console.error("用法：node scripts/build-server.mjs <outDir>");
  process.exit(1);
}

/** 服务端两个入口：[源文件, 产物名]。 */
const ENTRIES = [
  ["apps/server/src/index.ts", "index.mjs"],
  ["scripts/admin.ts", "admin.mjs"],
];

// CJS 依赖（fastify 生态）在 ESM 产物里的 require 垫片：定义真 require，否则动态 require 抛错。
const REQUIRE_SHIM =
  'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';

// 版本号单一出处 = CHANGELOG.md 的首个 `## [vX.Y.Z]`（发布流程先写日志再打 tag，docs/12）。
// 读不到就报错：宁可不打包，也不产出一个显示 "dev" 的发布产物（静默降级 = 两套真相）。
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const versionMatch = /^## \[v(\d+\.\d+\.\d+)\]/m.exec(changelog);
if (versionMatch === null) {
  console.error("CHANGELOG.md 里找不到当前版本标题（形如「## [v0.5.0] - 2026-10-21」）");
  process.exit(1);
}
const APP_VERSION = versionMatch[1];

const distDir = path.join(outDir, "apps/server/dist");
mkdirSync(distDir, { recursive: true });

for (const [entry, outName] of ENTRIES) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: path.join(distDir, outName),
    external: ["better-sqlite3", "sharp"],
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    logLevel: "warning",
    banner: { js: REQUIRE_SHIM },
  });
}
