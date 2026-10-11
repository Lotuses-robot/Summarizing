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

/** 跨 prompt 的 stdin 残留缓冲：管道喂多行（密码+确认）时一个 data 事件可能含多行——
 *  逐行消费；当前 prompt 拿走一行后，剩余留在缓冲里等下一个 prompt（曾因丢弃残行致静默失败）。 */
let stdinBuffer = "";

/** 从缓冲取一行（无换行可取的返回 null）；成功则消费掉该行。 */
function takeLine(): string | null {
  const nl = stdinBuffer.indexOf("\n");
  if (nl < 0) return null;
  const line = stdinBuffer.slice(0, nl).replace(/\r$/, "");
  stdinBuffer = stdinBuffer.slice(nl + 1);
  return line;
}

/** 明文回显读一行（用户名等非密输入；便携包首启引导用；管道输入同样可用）。 */
function promptVisible(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const buffered = takeLine();
    if (buffered !== null) {
      resolve(buffered);
      return;
    }
    /** 清理监听并定局（三个出口共用）。 */
    const settle = (fn: () => void): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.pause();
      fn();
    };
    /** 收到一段输入：缓冲并尝试成行。 */
    const onData = (chunk: Buffer): void => {
      stdinBuffer += chunk.toString("utf8");
      if (stdinBuffer.includes("\u0003")) {
        settle(() => reject(new Error("已取消")));
        return;
      }
      const line = takeLine();
      if (line !== null) settle(() => resolve(line));
    };
    /** EOF：剩余缓冲（无换行结尾）作一行交回（不悬置进程——曾因未决 promise 静默退出）。 */
    const onEnd = (): void => {
      const rest = stdinBuffer.replace(/\r$/, "");
      stdinBuffer = "";
      settle(() => resolve(rest));
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** 隐藏回显读一行（密码用；退格编辑、Ctrl-C 取消；管道输入同样可用）。 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let current = "";
    /** 收尾：还原终端、清监听、换行收束提示行。 */
    function settle(fn: () => void): void {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stdout.write("\n");
      fn();
    }
    /** 收到一段输入：缓冲并继续消费。 */
    function onData(chunk: Buffer): void {
      stdinBuffer += chunk.toString("utf8");
      drain();
    }
    /** EOF：当前行（可能为空）交回——空密码会在 ≥8 校验处响亮失败，不悬置。 */
    function onEnd(): void {
      settle(() => resolve(current));
    }
    /** 消费缓冲字符直到成行/取消/耗尽；返回是否已定局（EOF 前的残行留在缓冲供下一个 prompt）。 */
    function drain(): boolean {
      while (stdinBuffer !== "") {
        const ch = stdinBuffer[0] ?? "";
        stdinBuffer = stdinBuffer.slice(1);
        if (ch === "\r" || ch === "\n") {
          // CRLF 成对消费（评审修复）：只吃 \r 会把 \n 留给下一个 prompt → 立即空串定局
          if (ch === "\r" && stdinBuffer.startsWith("\n")) stdinBuffer = stdinBuffer.slice(1);
          settle(() => resolve(current));
          return true;
        }
        if (ch === "\u0003") {
          settle(() => reject(new Error("已取消")));
          return true;
        }
        if (ch === "\u007f" || ch === "\b") {
          current = current.slice(0, -1);
          continue;
        }
        current += ch;
      }
      return false;
    }
    if (drain()) return; // 缓冲里已有整行（管道喂多行的场景）——直接定局，不必等新事件
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
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
