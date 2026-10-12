// 服务端单文件打包单出处：esbuild 把 server 入口与 admin CLI 各打成自包含 .mjs，
// 只外挂 better-sqlite3（原生模块，运行时从 node_modules 加载）。build-release（便携包）与
// Dockerfile 共用——避免「入口清单 / --external / require 垫片」在两条产线上各写一份而静默漂移。
// 用法：node scripts/build-server.mjs <outDir>
import { mkdirSync } from "node:fs";
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
    external: ["better-sqlite3"],
    logLevel: "warning",
    banner: { js: REQUIRE_SHIM },
  });
}
