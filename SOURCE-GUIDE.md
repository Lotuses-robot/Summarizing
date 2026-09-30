# 开发一个信源（Source）

> 从零开始：30 分钟内给 Summarizing 接上你自己的消息来源。
> 写完之后，这个来源的消息会和群机器人一样自动进站、消化成事项——不需要改任何 core 代码。

## 信源是什么

Summarizing 是一条流水线，信源是它的入口：

```
你的来源（邮件 / RSS / 日历 / 任意 IM / 任何有消息的东西 …）
        │
   ┌────▼─────────┐
   │  信源适配器    │   ← 你写的部分：收消息、解释协议、打包、投递
   └────┬─────────┘
        │ ctx.ingest(批次)
        ▼
   原文档案 → AI 消化 → 事项看板 / 存疑库
```

信源 = `apps/server/src/sources/` 下的一个目录，实现 `SourceAdapter` 接口。
core 不认识你的协议，**甚至不知道有哪些信源**——你解释协议、你自己打包、你自己管设置；
core 只提供手段（`SourceContext`，下文的「八件套」）和场地（你可以挂自己的 HTTP 路由）。

如果你熟悉 Home Assistant 的 integration 或 Obsidian 的 plugin，信源是同一类东西——但更小：
没有 manifest、没有运行时加载、没有沙箱（D-88 的「明确不要」清单）。

## 开始之前

- Node.js ≥ 22；仓库 clone 后 `npm install`、`npm run dev` 能跑通；
- 会一点 TypeScript 就够——不需要读 core 源码；
- 契约全文在 `apps/server/src/sources/types.ts`；
  引用实现（webhook + 缓冲打包 + 白名单 + 设置）在 `apps/server/src/sources/nc/`。

## 10 分钟：你的第一个信源

**第 1 步 · 建目录写适配器** — `apps/server/src/sources/mysrc/index.ts`：

```ts
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { SettingField, SourceAdapter, SourceContext } from "../types";

/** 我的源：一句话说明它收什么、怎么收。 */
export function makeMysrcAdapter(): SourceAdapter {
  return {
    name: "mysrc",

    register(ctx: SourceContext, app: FastifyInstance): void {
      // 挂自己的路由（/api/sources/mysrc/...），或改用 ctx.setInterval 起轮询
      app.post("/api/sources/mysrc/event", async (req, reply) => {
        const body = z.object({ text: z.string().min(1) }).parse(req.body);
        // 单发源拿到即投；连发源先自己缓冲 + 去抖封批（见「打包」一节）
        const result = ctx.ingest({
          content: body.text,
          sourceType: "mysrc",
          sourceIdentity: { sourceLabel: "我的源" }, // 保留键 sourceLabel 非空；其余键自由
          eventTime: null, // 源自带时刻就填（本地墙钟），没有填 null
        });
        if (!result.ok) ctx.log.warn(`投递失败：${result.reason}`); // 感知落地，失败自决重试/丢弃
        return reply.code(202).send();
      });
    },

    settings(): SettingField[] {
      return [{ key: "endpoint", type: "text", label: "拉取地址", default: "https://…" }];
    },
  };
}
```

**第 2 步 · 注册表加一行** — `apps/server/src/sources/registry.ts`：

```ts
const ADAPTERS: SourceAdapter[] = [makeNcAdapter(), makeMysrcAdapter()];
```

**第 3 步 · 跑起来验证**：

```bash
npm run dev
curl -X POST http://localhost:3001/api/sources/mysrc/event \
  -H "content-type: application/json" -d '{"text":"10月8日前交数据结构作业"}'
```

打开看板：几秒到几十秒后，这条消息会被消化成一条事项；点开事项的「证据」能看到你刚投的原文。

> 消化这一步要跑 AI——第一次使用别忘了在 `.env` 里配好 OpenAI 兼容接入（见 README 的「上手」）。

## 你拥有的手段：ctx 八件套

`register(ctx, app)` 里的 `ctx` 是 core 给你的全部手段：

| 手段 | 用途 |
| --- | --- |
| `ctx.name` | 你的源名（日志前缀、设置命名空间、错误归属共用） |
| `ctx.log.debug / info / warn / error` | 日志口——core 统一加 `[source:<名>]` 前缀，便于过滤 |
| `ctx.ingest(batch)` | 投递口（下一节展开）；**有返回值**，失败不抛 |
| `ctx.getSetting / ctx.setSetting` | 读写本源的设置（命名空间隔离，core 不解释内容） |
| `ctx.onCleanup(fn)` | 清理注册表：定时器 / 监听器 / socket 都登记，关闭时按「后注册先撤销」逐项清理 |
| `ctx.setInterval(fn, ms)` | 定时器助手（自动登记进清理表，不用自己 clearInterval） |
| `ctx.reportError(err, { fatal? })` | 错误出口：报给 core 记入信源状态（`GET /api/sources` 的 `state / lastError`） |

⚠️ 一条红线：**ctx 里没有 db**。信源不摸数据库——收进来的东西只能走 `ctx.ingest` 这一条管线。

## 投递：ctx.ingest 的批次长什么样

```ts
const result = ctx.ingest({
  content: "10月8日前交数据结构作业",          // 纯文本原文——先在 raw_inputs 落档，永不丢
  sourceType: "mysrc",                        // = 你的源名（设置命名空间 / 路由前缀 / 排障标记共用）
  sourceIdentity: { sourceLabel: "课程群" },  // 弹性字典：必带 sourceLabel（给人看的来源名），其余键自由
  eventTime: null,                            // 源自带时刻就填（比"到达时间"真实，相对日期按它锚定）；没有填 null
  // raw: { … },                              // 可选：原始载荷留底（归档用，agent0/前端不消费）
});
if (!result.ok) {
  ctx.log.warn(`投递失败：${result.reason}`);   // 失败时别记去重 id、别清缓冲——留给下轮重试
}
```

`sourceIdentity` 是**弹性字典**：core 只要求 `sourceLabel` 非空，其他键随你填——邮件填发件地址、
网页填站点名、群聊填群号/发信人。你填的结构会随提示词交给 AI——**它就是 AI 判断来源权威性的眼睛**。

## 需要更多能力时

**连发型来源**（多条消息合并成一批，比如群里一条通知被拆成好几段）：
在适配器内做内存缓冲 + 去抖封批（组内静默够久 → 合并投递），窗长存设置里。
把封批决策写成纯函数方便测试——照抄 `sources/nc/index.ts` 的 `dueGroups` / `assembleBatch`。

**异步启动与收尾**：要先连外部服务才能上线 → 实现 `start?(): Promise<void>`
（可异步、可失败：失败只标记本信源 error，不拖垮别的信源）；有自己的运行态要清 → 实现 `stop?()`。
SIGINT 不归你管：core 统一收信号 → `app.close()` → 依次调各源 `stop()`。

**设置项**：实现 `settings?()` 声明纯数据（六型：`text / number / boolean / select / record / secret`），
core 落库后，**设置界面自动渲染出表单**——前端不知道你叫什么，表单完全按声明生成：

```ts
settings(): SettingField[] {
  return [
    { key: "endpoint", type: "text", label: "拉取地址", default: "https://…" },
    { key: "enabled", type: "boolean", label: "启用" },
    { key: "mode", type: "select", label: "模式", options: ["a", "b"] },
  ];
}
```

用户在设置界面把某个输入框清空 = `DELETE` 这个键（回「未设置」）——你 `getSetting` 兜默认值的逻辑会被直接触发。

## 错误与边界约定

- **`ctx.ingest` 不抛**——判返回值 `.ok`；失败时保留现场（别记去重 id、别清缓冲），下轮重试；
- **错误报 `ctx.reportError`**——不要抛出去污染主进程（无沙箱架构）；
- **白名单类过滤 fail-closed**——未配置 = 全不收（宁可漏，不可多收）；
- **入口快收**——webhook 一律快速 2xx（`nc` 用 204），校验不过静默丢，不阻塞推送方；
- **重推幂等自己做**——core 不替你去重（`nc` 用 message_id 环形集合）。

## 测试你的信源

单测参照 `apps/server/src/test/nc.test.ts`（覆盖三类：纯函数 / webhook 快收 / 封批全链路）：

- 两步装配：`makeApp(...)` + `registerSources(app, deps, [adapter])`，用 `app.inject` 打你的路由；
- 封批触发用**只假 `setInterval` / `clearInterval` 的假时钟**
  （`vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })`——全量假时钟会让 `app.inject` 挂死），
  且必须在 `registerSources` **之前**起假时钟，否则接管不到你的定时器；
- 断真实结果：`repo.listRawInputsByState(db, "digested")` 里出现你的批次。

全链路手测：真实事件 → 入口 2xx → `raw_inputs` 落档（pending → digested）→ 看板出事项 → 点开溯源到本批次原文。

## 提交你的信源

1. 目录 `apps/server/src/sources/<源名>/` + 注册表一行；
2. 设置项声明（如有）+ 对应的 `getSetting` 兜底逻辑；
3. 测试三类；`npm run check` 全绿；
4. 提 PR。

---

<sub>参考文件 · 契约 `apps/server/src/sources/types.ts` · 引用实现 `apps/server/src/sources/nc/` · 测试 `apps/server/src/test/nc.test.ts`</sub>
