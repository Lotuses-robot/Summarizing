import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import dotenv from "dotenv";
import { exitAfter, gracefulClose, makeApp, SHUTDOWN_TIMEOUT_MS } from "./app";
import { closeSpacesWithTimeout, makeSpaceHub } from "./spaces";
import { makeRegistryDb } from "./storage/registry";

// .env 固定在仓库根，按绝对路径加载——npm -w 会把 cwd 切到 workspace 目录，
// 相对加载曾在 cwd=apps/server 时静默解析出 0 个变量（实证过）。
dotenv.config({
  path: path.resolve(import.meta.dirname, "../../..", ".env"),
});

// data/ 同理固定在仓库根；发布包首次运行目录还不存在——自建（better-sqlite3 不建目录）。
// 006 起布局：system.db（账户登记）+ users/<uid>.db（每账户一库）。
const dataRoot = path.resolve(import.meta.dirname, "../../..", "data");
mkdirSync(dataRoot, { recursive: true });

// 系统库 + 空间集线器：装配 app（只装 core）→ 全量装配 active 账户的空间（含各库启动清扫）
// → listen。停用账户不装配——重新启用后首请求懒装配（空间模块注释在案）。
const registry = makeRegistryDb(path.join(dataRoot, "system.db"));
const hub = makeSpaceHub({ registry, dataRoot });

const app = makeApp({ registry, hub });

await hub.ensureAll();
// 注：账户多且带连接型 start 的信源时，串行 ensureAll 会拖长启动——届时改并行（熟人规模暂不做）。

// SIGINT 归 core（D-88 修正 D-84 遗留）：信源不再自己 process.on。
// gracefulClose（app.close）→ 空间 stop（各信源 stop + 清理表；套 SHUTDOWN_TIMEOUT_MS 隔离）→
// exitAfter 保底退出——任一环挂起都不许拖住 Ctrl-C（守卫测试在 nc.test / sources.test）。
process.on("SIGINT", () => {
  void exitAfter(gracefulClose(app).then(() => closeSpacesWithTimeout(hub, SHUTDOWN_TIMEOUT_MS)));
});

// 前端静态合并（发布包形态）：web/dist 存在就把前端并到同一端口——一个口出 UI + API。
// 路径：src 与打包后 dist 同层深（apps/server/{src,dist}），../../web/dist 两边都命中 apps/web/dist。
// dev 流程不受影响：前端照旧走 Vite 5173（若本地正好有 dist，3001 顺带服务一份，无碍）。
const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // 非 /api 与 /hook 的 GET 未命中文件 → 回 index.html（前端无路由，只为稳妥兜底）
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/hook")) {
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
