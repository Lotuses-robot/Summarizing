import type { FastifyInstance } from "fastify";
import type { RegistryDb } from "../storage/registry";
import type { SpaceHub } from "../spaces";
import { makeWecomIngress } from "./wecom/ingress";

// Router（D-130）：部署级单例，**只做接入与投递**。
//
// ```
// 外部 HTTP
//   ├── /relay/wecom/* ──→ Router（验签/解密/拉取/查绑定/回执）→ Source.accept({ raw, receivedAt })
//   └── /hook/<令牌>/nc/event ──→ nc 信源（自己管，不经 Router）
// ```
//
// **不做**：解析消息内容、算分组键、组装 identity、缓冲、切段、ingest——那些全是信源的事。
// 两条路在 `accept` 之后完全一致。
//
// 为什么 Router 不能是「信源的一个实例」：一个信源实例的 `ctx.ingest` 闭包写死了一个账户的库
// （`makeSourceContext`）。让一个实例服务多个账户，它就得认识 uid——击穿「信源不碰数据库、
// 不认识账户」的红线。Router 站在那条线外面：它认识 uid，但**不碰任何账户库**
// （只调 `Space.source(name).accept`，落库仍由该账户自己的 ctx 做）。

/** Router 的日志口（与信源的 `[source:<name>]` 对称——排障时一眼看出谁说的）。 */
export interface RouterLog {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 一个接入实现的形状（目录约定，不是新类型——`router/<协议>/ingress.ts` 导出的就是这个）。
 *
 *  将来加爬虫：隔壁加个目录、导出一个同形状对象、在 `makeRouter` 里多挂一条。 */
interface RelayIngress {
  /** 启动（可异步，可选）：起轮询兜底等。 */
  start?(): void | Promise<void>;
  /** 停止：撤销定时器/连接（可重复调用）。 */
  stop?(): void | Promise<void>;
  /** 把本接入的路由挂到 app 上（路径**由接入自己定**——Router 不认识任何具体协议）。 */
  register(app: FastifyInstance): void;
}

/** Router 句柄。 */
export interface Router {
  /** 启动全部接入（在 listen 之前；单个失败只留痕，不拖垮服务启动）。 */
  start(): Promise<void>;
  /** 停止全部接入（**先于**各账户信源 stop——不再产生新消息，再强制封批）。 */
  stop(): Promise<void>;
  /** 把接入路由挂到 app（`makeApp` 调用；Router 是部署级，挂在受保护作用域之外）。 */
  registerRoutes(app: FastifyInstance): void;
}

/** 造 Router。
 *
 *  入参 `db` = 系统库（凭据、绑定表、游标都在这——Router 不碰任何账户库）；
 *  `hub` = 空间集线器（投递用：`hub.ensure(uid)` → `space.source(name)`）；
 *  `log` 缺省写 stderr（core 的统一出口；测试可注入收集器）。
 */
export function makeRouter(args: { db: RegistryDb; hub: SpaceHub; log?: RouterLog }): Router {
  const log = args.log ?? stderrLog();
  const ingresses: RelayIngress[] = [makeWecomIngress(args.db, args.hub, log)];

  return {
    async start(): Promise<void> {
      for (const ing of ingresses) {
        try {
          await ing.start?.();
        } catch (err) {
          // 一个接入起不来不影响别的（与信源 start 同款隔离语义）——但必须留痕
          log.error(`接入启动失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },

    async stop(): Promise<void> {
      for (const ing of ingresses) {
        try {
          await ing.stop?.();
        } catch (err) {
          log.warn(`接入停止失败（继续）：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },

    registerRoutes(app: FastifyInstance): void {
      for (const ing of ingresses) ing.register(app);
    },
  };
}

/** 缺省日志口：写 stderr，统一 `[router]` 前缀（与 `[source:<name>]` 同一片日志流）。 */
function stderrLog(): RouterLog {
  /** 造某一级别的写入口。 */
  const at =
    (level: string) =>
    (msg: string): void => {
      process.stderr.write(`[router] ${level} ${msg}\n`);
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
