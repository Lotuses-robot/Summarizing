import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { errText } from "@summarizing/shared";
import { runAdmin, type AdminIo } from "../apps/server/src/cli/admin";

// 运维命令入口壳（006 / contracts/cli.md）——三形态同一份**内核**（src/cli/admin.ts）：
// dev `npm run admin -- <cmd>`（tsx）；发布包 `node apps/server/dist/admin.mjs <cmd>`；
// 服务器 `docker compose exec app node apps/server/dist/admin.mjs <cmd>`。
// 本壳只干终端的事：定位根（dataRoot / .env）、实现 IO、打印错误与退出码。

/** 定位仓库/发布包根（兼容两种运行深度：仓库 `scripts/` 与发布包 `apps/server/dist/`）。 */
function findRoot(): string {
  const here = import.meta.dirname;
  const candidates = [path.resolve(here, ".."), path.resolve(here, "../../..")];
  return candidates.find((c) => existsSync(path.join(c, ".env.example"))) ?? candidates[1] ?? ".";
}

/** 明文回显读一行（用户名等非密输入；便携包首启引导用）。 */
function promptVisible(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    let buf = "";
    /** 收到一段输入：按行切分（首行即答案）。 */
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      buf += s;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        stdin.removeListener("data", onData);
        stdin.pause();
        resolve(buf.slice(0, nl).replace(/\r$/, ""));
        return;
      }
      if (s.includes("\u0003")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        reject(new Error("已取消"));
      }
    };
    stdin.on("data", onData);
  });
}

/** 隐藏回显读一行（密码用；Ctrl-C 或退格处理）。 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    /** 收到一段输入：逐字符处理（回车提交、退格删、Ctrl-C 取消；成对增删不回显）。 */
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** 终端 IO（默认实现）。 */
function makeTerminalIo(): AdminIo {
  return {
    prompt: (question, opts) => (opts.secret ? promptHidden(question) : promptVisible(question)),
    log: (line) => {
      console.log(line);
    },
  };
}

/** 入口。 */
async function main(): Promise<void> {
  const root = findRoot();
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  const baseUrl = process.env.BASE_URL;
  await runAdmin(process.argv.slice(2), {
    dataRoot: path.join(root, "data"),
    io: makeTerminalIo(),
    ...(baseUrl === undefined || baseUrl === "" ? {} : { baseUrl }),
  });
}

main().catch((err: unknown) => {
  console.error(`[admin] ${errText(err)}`);
  process.exitCode = 1;
});
