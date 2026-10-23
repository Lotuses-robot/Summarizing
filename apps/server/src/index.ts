import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import dotenv from "dotenv";
import { exitAfter, gracefulClose, makeApp, SHUTDOWN_TIMEOUT_MS } from "./app";
import { closeSpacesWithTimeout, makeSpaceHub } from "./spaces";
import { makeRegistryDb } from "./storage/registry";
import { makeRouter } from "./router";

// .env 固定在仓库根，按绝对路径加载——npm -w 会把 cwd 切到 workspace 目录，
// 相对加载曾在 cwd=apps/server 时静默解析出 0 个变量（实证过）。
dotenv.config({
  path: path.resolve(import.meta.dirname, "../../..", ".env"),
});

// data/ 同理固定在仓库根；发布包首次运行目录还不存在——自建（better-sqlite3 不建目录）。
// 006 起布局：system.db（账户登记）+ users/<uid>.db（每账户一库）。
const dataRoot = path.resolve(import.meta.dirname, "../../..", "data");
mkdirSync(dataRoot, { recursive: true });

// 系统库 + 空间集线器：装配 app（只装 core）→ 全量装配 active 账户的空间（含各库启动清扫
// 与被打断批次的自动重试，D-116）→ listen。停用账户不装配——重新启用后首请求懒装配（空间模块注释在案）。
const registry = makeRegistryDb(path.join(dataRoot, "system.db"));
const hub = makeSpaceHub({ registry, dataRoot });

// Router（D-130）：部署级单例——微信客服这类「一个入口对接多个账户」的接入走它。
// 它自己的接入路由由 `registerRoutes` 挂到 app 上（`/relay/<协议>/*`）。
const router = makeRouter({ db: registry, hub });
const app = makeApp({ registry, hub, router });

await hub.ensureAll();
// Router 接入启动（轮询兜底等）：在 listen 之前——第一个回调到达时拉取链路已就绪
await router.start();
// 注：账户多且带连接型 start 的信源时，串行 ensureAll 会拖长启动——届时改并行（熟人规模暂不做）。

// SIGINT 归 core（D-88 修正 D-84 遗留）：信源不再自己 process.on。
// gracefulClose（app.close）→ 空间 stop（各信源 stop + 清理表；套 SHUTDOWN_TIMEOUT_MS 隔离）→
// exitAfter 保底退出——任一环挂起都不许拖住 Ctrl-C（守卫测试在 nc.test / sources.test）。
// SIGTERM 同款（批次 2 / Docker）：容器里 node 即 PID 1，内核不代它执行默认「收到即终止」——
// 无处理器 = docker stop / compose down 的 SIGTERM 被忽略、10s 宽限后 SIGKILL，优雅关停永不执行。
/** 优雅关停（SIGINT/SIGTERM 共用）：**先停 Router（不再产生新消息）→ 再关 HTTP → 最后停各空间
 *  （信源强制封批）**，exitAfter 保底退出。顺序不能反：Router 先停，已经在途的消息才不会在
 *  信源缓冲被清空之后又落进来（那批会丢且无痕）。 */
const onShutdown = (): void => {
  void exitAfter(
    router
      .stop()
      .then(() => gracefulClose(app))
      .then(() => closeSpacesWithTimeout(hub, SHUTDOWN_TIMEOUT_MS)),
  );
};
process.on("SIGINT", onShutdown);
process.on("SIGTERM", onShutdown);

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
