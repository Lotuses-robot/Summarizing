// .env 极简读写（无依赖——运维脚本要在只装了 docker+node 的服务器上跑，不 import 任何包）。
// 归一与 docker compose / dotenv 对齐：认 `export ` 前缀；引号值剥引号（引号内的 ' #' 不算注释）；
// 未引号值剥 ' # ...' 行内注释。不做转义序列解析（.env.example 为准）。
// 共用方：upgrade.mjs（读 APP_IMAGE + 改 tag）与 status.mjs（读 APP_IMAGE 显示）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 值归一：先剥行内注释（' # ...'，含行首就是 `#` 的整注释情形），再处理引号；
 *  引号值剥首尾一对引号并校验其后只剩注释/空白——否则视为坏形态返回原样（不返回腐值、不猜）。 */
function parseValue(raw) {
  // 先剥注释：注释标记 = 空白后的 '#'，或串首就是 '#'（`KEY= # 空值注释` → 空串）。
  // 注意必须先于 trim 判串首——调用方已 trim，故这里用 (^|\s)# 同时覆盖两种（审查 2026-10-14）。
  const noComment = raw.replace(/(^|\s)#.*$/, "").trim();
  const first = noComment[0];
  if (first !== '"' && first !== "'") return noComment;
  const close = noComment.indexOf(first, 1);
  // 闭合引号须在串尾（其后已无内容——注释已被剥）→ 取引号内字面量
  if (close > 0 && close === noComment.length - 1) return noComment.slice(1, close);
  return noComment; // 未闭合 / 引号后还有残留内容 → 原样返回（不猜、不返回半截腐值）
}

/** 读 .env：返回文件路径、原始行（改写时保留注释/顺序）与解析出的键值；文件不存在返回空。 */
export function readDotEnv(root) {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return { file, lines: [], vars: {} };
  const lines = readFileSync(file, "utf8").split("\n");
  const vars = {};
  for (const line of lines) {
    const t = line.trim().replace(/^export\s+/, "");
    if (t === "" || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    vars[t.slice(0, i).trim()] = parseValue(t.slice(i + 1).trim());
  }
  return { file, lines, vars };
}

/** 把 .env 里 APP_IMAGE 改为 imageRef（其余行原样保留）。保留该行的 `export ` 前缀、行内注释与行尾（CRLF）——
 *  只换 '=' 后面的值（审查 2026-10-14：曾整行重写成 `APP_IMAGE=…`，丢掉 export/注释与 \r）。
 *  compose 的 pull/up 都读 .env。 */
export function writeAppImage(env, imageRef) {
  let found = false;
  const lines = env.lines.map((line) => {
    // 行尾原样保留（CRLF 文件别被改成混合行尾）
    const eol = line.endsWith("\r") ? "\r" : "";
    const body = eol === "" ? line : line.slice(0, -1);
    const m = /^(\s*(?:export\s+)?APP_IMAGE\s*=\s*)(.*)$/.exec(body);
    if (m === null) return line;
    found = true;
    // 注释部分（值后 ' # ...'）原样接回，不改动
    const rest = m[2];
    const hash = rest.indexOf("#");
    const comment = hash >= 0 ? rest.slice(rest.lastIndexOf(" ", hash) + 1) : "";
    const sep = comment !== "" ? " " : "";
    return `${m[1]}${imageRef}${sep}${comment}${eol}`;
  });
  if (!found) throw new Error(".env 里没有 APP_IMAGE 行（ACR 形态必须有它，见 docs/13 二·1）");
  writeFileSync(env.file, lines.join("\n"));
}
