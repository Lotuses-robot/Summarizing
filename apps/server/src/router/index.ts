import type { FastifyInstance } from "fastify";
import type { RegistryDb } from "../storage/registry";
import type { SpaceHub } from "../spaces";
import {
  makeBindingStore,
  makeDeliverySwitch,
  type BindingStore,
  type DeliverySwitch,
} from "./store";
import { migrateLegacyRelayKeys } from "./migrate";

// Router（D-130）：部署级单例，**只做接入与投递**。
//
// ```
// 外部 HTTP
//   ├── /relay/wecom/* ──→ Router（验签/解密/拉取/查绑定/回执）→ Source.accept({ raw, receivedAt })
//   ├── /relay/<其他>/* ──→ 同理（校内新闻、公开网站……）
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
//
// **加一个新接入要动哪里**（D-134 的判据——只该动这些）：
//   ① 新建 `router/<接入>/`（ingress + 它自己的协议实现）；
//   ② 在下面的 `INGRESS_FACTORIES` 加一行；
//   ③ 在 `sources/registry.ts` 加一个只做消化的信源。
// `app.ts` / 账户侧路由 / 前端一行都不用改——它们都按**接入自己声明的元数据**渲染。

/** Router 的日志口（与信源的 `[source:<name>]` 对称——排障时一眼看出谁说的）。 */
export interface RouterLog {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 一个接入实现的形状（目录约定，不是新类型——`router/<协议>/ingress.ts` 导出的就是这个）。
 *
 *  将来加爬虫：隔壁加个目录、导出一个同形状对象、在 `INGRESS_FACTORIES` 里多挂一条。 */
export interface RelayIngress {
  /** 接入名（= 它投递时用的信源名；也是绑定表/开关的分区键）。 */
  readonly name: string;
  /** 给人看的名字（账户侧「路由」区按它分卡：「微信客服」「校内新闻」…）。 */
  readonly label: string;
  /** 一句说明（那张卡的副标题：往这儿送的是什么消息）。 */
  readonly description: string;
  /** 本接入的账户侧绑定表（各持一份，见 store.ts）。 */
  readonly bindings: BindingStore;
  /** 本接入的账户侧分发开关（各持一份，见 store.ts）。 */
  readonly delivery: DeliverySwitch;
  /** 启动（可异步，可选）：起轮询兜底等。 */
  start?(): void | Promise<void>;
  /** 停止：撤销定时器/连接（可重复调用）。 */
  stop?(): void | Promise<void>;
  /** 把本接入的路由挂到 app 上（路径**由接入自己定**——Router 不认识任何具体协议）。 */
  register(app: FastifyInstance): void;
  /** 最近的运行状态（L28：让「Router 出错」在界面上看得见，不用 SSH 翻日志）。
   *  缺席 = 本接入不维护状态（那张卡就不显示状态行）。 */
  state?(): RelayState;
}

/** 一个接入的运行状态（与信源卡的 `SourceState` 同形态：ok / 最近一次错误）。
 *
 *  为什么要它：Router 里的失败（验签不过、拉取报错、回执发不出去、会话状态异常）
 *  原先只写 stderr——排查必须 SSH + 对照微信文档。信源那边早有这条通道
 *  （`ctx.reportError` → `GET /api/sources`），Router 缺了同一份。 */
export interface RelayState {
  state: "ok" | "error";
  /** 最近一次错误的人话原因（`state=error` 时显示在卡上）。 */
  lastError?: string;
  /** 最近一次出错时刻（北京墙钟）——让「最近出错」能回答「多久以前」。 */
  lastErrorAt?: string;
}

/** Router 句柄。 */
export interface Router {
  /** 启动全部接入（在 listen 之前；单个失败只留痕，不拖垮服务启动）。 */
  start(): Promise<void>;
  /** 停止全部接入（**先于**各账户信源 stop——不再产生新消息，再强制封批）。 */
  stop(): Promise<void>;
  /** 把接入路由挂到 app（`makeApp` 调用；Router 是部署级，挂在受保护作用域之外）。 */
  registerRoutes(app: FastifyInstance): void;
  /** 已上岗的接入（账户侧路由按它渲染分组——**前端不认识具体的接入名**）。 */
  ingresses(): RelayIngress[];
}

/** 造一个接入（`makeRouter` 用；测试注入替身接入时不改生产路径）。 */
export type IngressFactory = (args: {
  db: RegistryDb;
  hub: SpaceHub;
  log: RouterLog;
}) => RelayIngress;

/** 生产接入表：**加一个接入 = 这里加一行**。每行自带它的名字与账户侧文案。
 *
 *  ⚠️ **当前为空：微信接入已停用**（2026-10-23）。
 *
 *  原因：企业微信以《用户账号使用规范》为由限制了账号，我们对规则的理解不足——
 *  测试期把自动回执间隔调到 6 秒连测数次（3.5.11.3 骚扰及垃圾信息），
 *  并为让客户收到回执写过「自动转入人工再结束会话」的状态流转，等于绕开平台对
 *  会话状态的管理（3.2.2 恶意绕开或者对抗腾讯规则）。申诉期间全部停止。
 *
 *  恢复时把这一行加回来即可（代码与测试都保留，未被删除）：
 *    ({ db, hub, log }) => makeWecomIngress(db, hub, log)
 *  恢复前必须先改掉上面两处行为：回执间隔回到保守值、不再自动流转会话状态。 */
const INGRESS_FACTORIES: IngressFactory[] = [];

/** 造 Router。
 *
 *  入参 `db` = 系统库（凭据、绑定表、游标都在这——Router 不碰任何账户库）；
 *  `hub` = 空间集线器（投递用：`hub.forDelivery(uid)` → `space.source(name)`）；
 *  `log` 缺省写 stderr（core 的统一出口；测试可注入收集器）；
 *  `factories` 缺省取生产接入表（测试注入替身接入）。
 */
export function makeRouter(args: {
  db: RegistryDb;
  hub: SpaceHub;
  log?: RouterLog;
  factories?: IngressFactory[];
}): Router {
  const log = args.log ?? stderrLog();
  // v0.7.0 → v0.7.1 的键迁移：把旧的全局绑定表/开关归到 wecom 名下（幂等，无事可做就 0）
  migrateLegacyRelayKeys(args.db);
  const ingresses = (args.factories ?? INGRESS_FACTORIES).map((make) =>
    make({ db: args.db, hub: args.hub, log }),
  );

  return {
    async start(): Promise<void> {
      for (const ing of ingresses) {
        try {
          await ing.start?.();
        } catch (err) {
          // 一个接入起不来不影响别的（与信源 start 同款隔离语义）——但必须留痕
          log.error(
            `接入 ${ing.name} 启动失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    async stop(): Promise<void> {
      for (const ing of ingresses) {
        try {
          await ing.stop?.();
        } catch (err) {
          log.warn(
            `接入 ${ing.name} 停止失败（继续）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    registerRoutes(app: FastifyInstance): void {
      for (const ing of ingresses) ing.register(app);
    },

    ingresses(): RelayIngress[] {
      return ingresses;
    },
  };
}

/** 造一个接入的绑定表与开关（各 ingress 在自己的构造里呼它——键按自己的 name 分区）。 */
export function makeIngressStores(
  db: RegistryDb,
  name: string,
): { bindings: BindingStore; delivery: DeliverySwitch } {
  return { bindings: makeBindingStore(db, name), delivery: makeDeliverySwitch(db, name) };
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
