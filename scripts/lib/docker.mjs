// docker 探测小库（运维脚本共用——upgrade.mjs / status.mjs 的「在跑 app 镜像」同一段舞步收敛于此）。
// 与 lib/dotenv.mjs 同为无依赖、可独立于容器 mjs；命令取不到一律不抛（诊断用途要容错）。

import { execFileSync } from "node:child_process";

/** 跑一条命令取 stdout；失败返回 null（不抛——调用方按「取不到」处理）。 */
function cap(cwd, cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** 在跑的 app 容器镜像 ref：成功 {ref}；失败带归因 {problem}——
 *  "docker-unavailable"（docker/compose 不可用、非 compose 目录、daemon 未起等命令本身失败）与
 *  "no-container"（命令成功但没容器）分开报，防误导排查方向。 */
export function liveAppImageRef(cwd) {
  const id = cap(cwd, "docker", ["compose", "ps", "-q", "app"]);
  if (id === null) return { problem: "docker-unavailable" };
  if (id === "") return { problem: "no-container" };
  // compose ps -q 可能给多行（本仓只有一个 app 服务）——取首行
  const insp = cap(cwd, "docker", ["inspect", "--format", "{{.Config.Image}}", id.split("\n")[0]]);
  // inspect 命令本身失败（daemon 打嗝/容器刚被重建/权限）→ 归「不可用」（命令失败=环境问题，非「无容器」）
  if (insp === null) return { problem: "docker-unavailable" };
  if (insp === "") return { problem: "no-container" };
  return { ref: insp };
}
