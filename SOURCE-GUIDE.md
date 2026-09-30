# 写一个信源 · 跟着 nc 走一遍

> 最快的学法不是背接口，是读一个真货。
> 这份指南带你把 `apps/server/src/sources/nc/` 从头读一遍，再照着换成你自己的来源，大约 15 分钟。
>
> 先交代读法：第一节把会用到的词解释清楚；第二节把你要实现的接口（`types.ts`）讲透；
> 之后每一节都对应 nc 里的一段真实代码。**所有规则以 `types.ts` 的注释为准**，这里只帮你读懂它。

## 一、先把词解释清楚：信源、适配器

**信源（source）** = 一路消息的来源，加上把它接进来的那段代码。
群里机器人是一个信源；以后你想接邮件、RSS、日历，每一个都算一个信源。

**适配器（adapter）** 是软件里很常见的说法：当两边的接口对不上时，夹在中间做翻译的一小层。
信源适配器（代码里叫 `SourceAdapter`）做的事就一句话：**把你那路来源的协议，翻译成 Summarizing 能接收的投递格式。**

```
你的来源 ──(你的协议，随便长什么样)──▶ 适配器 ──ctx.ingest──▶ 原文存档 → AI 消化 → 看板
                                        ↑ 你写的就这一层
```

这样做的好处是：core 不认识你的协议，所以你**不用改 core**；core 也不认识任何具体信源——你写你的适配器就行。

## 二、你要实现的接口：`types.ts`

所有"翻译"都发生在两个接口之间（定义在 `apps/server/src/sources/types.ts`，**不用改它，是拿来对照的**）：

**`SourceAdapter`** —— 你的适配器要长成的样子，五个成员（后三个可选）：

```ts
export interface SourceAdapter {
  readonly name: string;       // 短名：URL 里、设置里、日志前缀都用它
  register(ctx, app): void;    // 被接入时调一次：注册 HTTP 接口、起定时循环——不做慢操作
  start?(): Promise<void>;     // 可选：需要先连外部服务才能上线时写（可异步、可失败）
  stop?(): Promise<void>;      // 可选：关服时收尾（清理自己的运行状态）
  settings?(): SettingField[]; // 可选：声明设置项，设置界面会自动生成表单
}
```

**`SourceContext`** —— core 发给你的一包工具（代码里缩写叫 `ctx`，就是"上下文"的意思）：

```ts
name                        // 你的短名
ingest(batch)               // 唯一的投递入口：把消息交给流水线——不抛错，给返回值
getSetting / setSetting     // 读写你自己的设置项（各信源互不干扰）
log.debug / info / warn / error  // 日志：core 自动加 [source:你的名字] 前缀
onCleanup(fn)               // 登记要清理的东西（定时器、监听器…），关服时 core 统一撤销
setInterval(fn, ms)         // 起定时循环（自动登记，不用自己关）
reportError(err, { fatal? }) // 报错给 core——它会替你记进状态（GET /api/sources 能看到）
```

每个字段的 JSDoc 注释就是全部规则。拿不准时，回这个文件对照。

## 三、nc 的结构：四个部分

打开 `sources/nc/index.ts`，文件最底部的 `makeNcAdapter()` 返回一个对象——**它只实现了五个成员里的四个**
（`start` 是可选的，nc 不需要它）：

```ts
export function makeNcAdapter(): SourceAdapter {
  return {
    name: NC_SOURCE_NAME,        // ① 叫什么
    register(ctx, app) { … },    // ② 被接入时做什么：注册 HTTP 接口 + 起定时循环
    async stop() { … },          // ③ 关服时收尾
    settings() { … },            // ④ 有哪些设置项
  };
}
```

下面逐个部分看，每段都告诉你"为什么这么写"。

## 四、第 ① 部分 · name

```ts
const NC_SOURCE_NAME = "nc";
```

就是起个短名——但这个字符串到处要用：它是 URL 的一段（`/api/sources/nc/…`）、
设置的命名空间（各信源的设置互不干扰靠它）、日志前缀、排障标记。
**你的源取个短名，全局统一用它。**

## 五、第 ② 部分 · register：消息是怎么进来的

`register` 注册一个 HTTP 接口（"路由"），核心是这么一段：

```ts
app.post("/api/sources/nc/event", async (req, reply) => {
  const parsed = NcEventSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(204).send(); // 形状不对 → 静默丢

  // （nc 特有的白名单过滤与重推判断在这里；这是它的业务需要，不是通用要求——细节看源码注释）
  …
  const result = ctx.ingest({
    content: textFromSegments(ev.message, ev.raw_message),
    sourceType: NC_SOURCE_NAME,
    sourceIdentity: { sourceLabel: groupName, groupId: ev.group_id, sender },
    eventTime: wallClockFromUnix(ev.time),
    raw: ev, // 原始载荷留底（可选）
  });
  if (!result.ok) { ctx.log.error(…); return; } // 投递失败：留痕，下一轮重试
  return reply.code(204).send();
});
```

三个值得抄的点：

1. **入口立刻回**——收到就马上回 2xx（nc 用 204，连响应体都不要），不拖住推送方。参数不对就静默丢，不让脏数据进流水线。
2. **`ctx.ingest` 是唯一的投递入口**——整理成文本后交给它，core 会先把原文存档、再让 AI 异步消化。它**不抛错、给返回值**：判 `result.ok` 决定重试还是丢弃。
3. **失败时别清现场**——nc 投递失败时不记去重标记、不清缓冲，留给下一轮重试（代码注释里那句"否则该批消息既不落库又被去重吞掉"，就是这段最值钱的地方）。

**关于缓冲合并**：nc 的来源消息会一连来好几条（群里一条通知常被拆成几段发），所以它先把同群消息攒进内存（缓冲），
静默满 3 分钟才合并成一批投递。**如果你的来源每次就来一条完整的**——邮件、日历、单条推送——**这整块都不需要**，全部核心就这么点：

```ts
app.post("/api/sources/mysrc/event", async (req, reply) => {
  const body = z.object({ text: z.string().min(1) }).parse(req.body);
  ctx.ingest({
    content: body.text,
    sourceType: "mysrc",
    sourceIdentity: { sourceLabel: "我的来源" }, // 身份字典：sourceLabel 必填（给人看的来源名），其余键随你加
    eventTime: null,                             // 源自带时刻就填，没有填 null
  });
  return reply.code(200).send();
});
```

定时拉取型的来源同理：`register` 里用 `ctx.setInterval(拉取, 间隔)` 起个循环，拉到东西就 `ctx.ingest`——
定时器会自动登记，关服时由 core 统一撤销，你不用自己关。

## 六、第 ③ 部分 · settings：设置界面为什么自己长出表单

```ts
settings(): SettingField[] {
  return [
    { key: "groups", type: "record", label: "群白名单", description: "…" },
    { key: "windowMinutes", type: "number", label: "打包窗长（分钟）", default: 3, description: "…" },
  ];
}
```

设置项写成**纯数据的声明**（共六种类型：`text / number / boolean / select / record / secret`）。
core 把它存下来，前端的设置界面**照声明自动生成表单**——前端根本不知道你叫什么名字。
读值的写法是 `ctx.getSetting("windowMinutes")`，记得兜默认值（用户在界面上清空某个键 = 恢复"未设置"，你的兜底逻辑会被直接触发）。没有可配置项的源，这个成员就省略。

## 七、第 ④ 部分 · stop：关服时的收尾

nc 的 `stop()` 把缓冲里攒着的消息全部发出去，尽量不丢。**你的源没有运行状态，这个成员就省略。**
注意 `SIGINT`（Ctrl-C）不用你管：core 统一接收信号 → 关服 → 依次调用各源的 `stop()`。

## 八、换成你自己的源（四步）

1. 建目录 `apps/server/src/sources/mysrc/`，照 nc 的结构写，改 `name` 和接口路径；
2. 把"收消息"那一段换成你的来源（HTTP 接口 / 定时拉取 / 随便什么——拿到内容就 `ctx.ingest`）；
3. `sources/registry.ts` 里加一行；
4. `npm run dev` 后 curl 一条试试，看板上出现事项 = 打通了：

```bash
curl -X POST http://localhost:3001/api/sources/mysrc/event \
  -H "content-type: application/json" -d '{"text":"10月8日前交数据结构作业"}'
```

## 九、出问题时看哪里

- **日志**：`ctx.log` 打的东西在终端里，带 `[source:你的名字]` 前缀；
- **状态**：`GET /api/sources` 能看到每个信源的 `state` 和 `lastError`——core 替你记的，不用自己维护；
- **测试**：直接抄 `apps/server/src/test/nc.test.ts`（里面注释写了唯一一个坑：假时钟只假 `setInterval`，且要在注册**之前**起）；
- **其余约定**（投递不抛错、白名单类过滤"没配置就全都不收"、同一消息重复推送不会重复入库……）都写在 `types.ts` 的注释里。

---

<sub>完整接口 `apps/server/src/sources/types.ts` · 示例实现 `apps/server/src/sources/nc/` · 测试 `apps/server/src/test/nc.test.ts`</sub>
