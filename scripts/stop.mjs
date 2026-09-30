// 杀掉占用本项目端口（3001 后端 / 5173 前端）的进程。
// 用途：npm run dev 被 Ctrl+C 后偶有残留进程占端口，下次启动失败时跑 `npm run stop`。
import { execSync } from "node:child_process";

const PORTS = [3001, 5173];
const killed = [];

for (const port of PORTS) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`)
      .toString()
      .trim();
    const pids = [...new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()))];
    for (const pid of pids) {
      execSync(`taskkill /F /PID ${pid}`);
      killed.push(`${port}(pid ${pid})`);
    }
  } catch {
    // 该端口本来就没被占用
  }
}

console.log(killed.length === 0 ? "没有残留进程，端口都是干净的" : `已结束: ${killed.join(", ")}`);
