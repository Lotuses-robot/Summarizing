// .env 极简读写（无依赖——运维脚本要在只装了 docker+node 的服务器上跑，不 import 任何包）。
// 只认 KEY=VALUE 行；值的内联注释（' # ...'）按 docker compose 同款剥掉；不做引号解析（.env.example 为准）。
// 共用方：upgrade.mjs（读 APP_IMAGE + 改 tag）与 status.mjs（读 APP_IMAGE 显示）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 读 .env：返回文件路径、原始行（改写时保留注释/顺序）与解析出的键值；文件不存在返回空。 */
export function readDotEnv(root) {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return { file, lines: [], vars: {} };
  const lines = readFileSync(file, "utf8").split("\n");
  const vars = {};
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    vars[t.slice(0, i).trim()] = t.slice(i + 1).replace(/\s+#.*$/, "").trim();
  }
  return { file, lines, vars };
}

/** 把 .env 里 APP_IMAGE 改为 imageRef（其余行原样保留）——compose 的 pull/up 都读 .env。 */
export function writeAppImage(env, imageRef) {
  let found = false;
  const lines = env.lines.map((line) => {
    const t = line.trim();
    if (t.startsWith("#")) return line;
    const i = t.indexOf("=");
    if (i <= 0 || t.slice(0, i).trim() !== "APP_IMAGE") return line;
    found = true;
    return `APP_IMAGE=${imageRef}`;
  });
  if (!found) throw new Error(".env 里没有 APP_IMAGE 行（ACR 形态必须有它，见 docs/13 二·1）");
  writeFileSync(env.file, lines.join("\n"));
}
