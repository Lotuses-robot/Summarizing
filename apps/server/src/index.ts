import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import dotenv from "dotenv";
import { exitAfter, gracefulClose, makeApp, registerSources, startSources } from "./app";
import { readStoredAi } from "./routes/settings";
import { envFromAiSettings, makeOpenAiLlm, type TaggedLlm } from "./shared/llm";
import { sweepOrphanPending } from "./features/agent0/digest";
import { allSourceAdapters } from "./sources/registry";
import { makeDb } from "./storage/db";

// .env 固定在仓库根，按绝对路径加载——npm -w 会把 cwd 切到 workspace 目录，
// 相对加载曾在 cwd=apps/server 时静默解析出 0 个变量（实证过）。
dotenv.config({
  path: path.resolve(import.meta.dirname, "../../..", ".env"),
});

// data/ 同理固定在仓库根；发布包首次运行目录还不存在——自建（better-sqlite3 不建目录）
const dataFile = path.resolve(import.meta.dirname, "../../..", "data", "summarizing.db");
mkdirSync(path.dirname(dataFile), { recursive: true });

const db = makeDb(dataFile);
// 启动清扫（L11）：重启此刻不存在在途消化，残留 pending 即上次中断的孤儿——置「未处理」可见可重试
sweepOrphanPending(db);

// LLM 引用（05§五 热切换）：默认 .env；设置表存了覆盖就热启动（坏 JSON/形状不符由 readStoredAi 警告并回退 .env，不崩）
const llmRef: { current: TaggedLlm } = { current: makeOpenAiLlm() };
const storedAi = readStoredAi(db);
if (storedAi !== null) {
  llmRef.current = makeOpenAiLlm(envFromAiSettings(storedAi));
}

// 三时机装配（D-88）：① makeApp 只装 core（不认识信源）② registerSources 信源上岗（挂路由/定时器）
// ③ startSources 信源启动（可异步、可失败——失败只标该信源，不拖垮别的）。
const adapters = allSourceAdapters();
const app = makeApp({ db, llmRef });
registerSources(app, { db, llmRef }, adapters);

// SIGINT 归 core（D-88 修正 D-84 遗留）：信源不再自己 process.on。
// gracefulClose → 各信源 stop（如 nc 强制封批）+ 清理表；exitAfter 保底退出——
// close 中途失败也必须 exit，否则 Ctrl-C 停不掉进程（守卫测试在 nc.test）。
process.on("SIGINT", () => {
  void exitAfter(gracefulClose(app));
});

await startSources(app, adapters);
// 注：源多且带连接型 start 时，串行 await 会拖长启动（最坏 N 源 × 超时）——
// 届时改「listen 先行 + startSources 用 Promise.all」，缓冲型适配器照收不误。

// 前端静态合并（发布包形态）：web/dist 存在就把前端并到同一端口——一个口出 UI + API。
// 路径：src 与打包后 dist 同层深（apps/server/{src,dist}），../../web/dist 两边都命中 apps/web/dist。
// dev 流程不受影响：前端照旧走 Vite 5173（若本地正好有 dist，3001 顺带服务一份，无碍）。
const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // 非 /api 的 GET 未命中文件 → 回 index.html（前端无路由，只为稳妥兜底）
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });
}

// 端口：PORT 环境变量优先（发布包/多实例避端口冲突用），默认 3001。
const port = Number(process.env.PORT ?? "") || 3001;

// host 0.0.0.0：开发期局域网/Tailscale 直连 API（前端 5173 经 Vite proxy 也能用）；
// 上线部署时收紧回具体网卡
await app.listen({ port, host: "0.0.0.0" });
