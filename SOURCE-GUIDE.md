# 写一个信源 · 跟着 nc 走一遍

> 最快的学法不是背契约，是读一个真货。
> `nc` 是这个仓库自带的信源示例（收群消息的 webhook 源）——这份指南带你把 `apps/server/src/sources/nc/` 从头到尾读一遍，
> 然后照着换成你自己的来源。整个过程大概 15 分钟。

一句话版本：**信源 = `sources/` 下一个目录 + 实现 `SourceAdapter` 接口 + 注册表加一行**。
就这么多，剩下的 cc 只认接口。

```
你的来源 → 你的适配器 → ctx.ingest → 原文档案 → AI 消化 → 看板
```

## 先从整体看：它就是一个对象

打开 `sources/nc/index.ts`，最底下是全部的门面——`makeNcAdapter()` 返回一个对象，只有四个键：

```ts
export function makeNcAdapter(): SourceAdapter {
  return {
    name: NC_SOURCE_NAME,        // ① 叫什么
    register(ctx, app) { … },    // ② 上岗时做什么（挂路由 / 起定时器）
    async stop() { … },          // ③ 关服时收尾（可选）
    settings() { … },            // ④ 有哪些设置项（可选）
  };
}
```

完整接口在 `sources/types.ts`，每个字段都带注释。**照着接口严格来就行**——这份指南只告诉你每一块在干嘛，格式以那里的注释为准。

## 第 ① 件 · name

```ts
const NC_SOURCE_NAME = "nc";
```

短名而已，但这个字符串到处要用：它是 URL 的段（`/api/sources/nc/…`）、设置的命名空间、日志前缀、排障标记。**你的源取个短名，全局统一用它。**

## 第 ② 件 · register：消息是怎么进来的

nc 的 `register` 干两件事：**挂一条 webhook 路由** + **起一个定时器**。核心是那条路由：

```ts
app.post("/api/sources/nc/event", async (req, reply) => {
  const parsed = NcEventSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(204).send(); // 形状不对 → 静默丢

  // （nc 特有：白名单过滤、重推幂等、塞进缓冲——见下）
  …
  const result = ctx.ingest({
    content: textFromSegments(ev.message, ev.raw_message),
    sourceType: NC_SOURCE_NAME,
    sourceIdentity: { sourceLabel: groupName, groupId: ev.group_id, sender },
    eventTime: wallClockFromUnix(ev.time),
    raw: ev, // 原始载荷留底（可选）
  });
  if (!result.ok) { ctx.log.error(…); return; } // 落地失败：留痕，不清缓冲，下轮重试
  return reply.code(204).send();
});
```

三个关键点，都值得抄：

1. **快收**——入口一律立刻 2xx（nc 用 204 连响应体都不要）。校验不过就静默丢：不阻塞推送方，也不把脏数据放进流水线。
2. **`ctx.ingest` 是唯一的投递口**——收到了、整理成文本了，就交给它；core 负责先落原文档案、再异步让 AI 消化。它**不抛错、给返回值**——判 `result.ok` 决定重试还是丢弃。
3. **失败时别清理现场**——nc 在投递失败时不记去重 id、不清缓冲，留给下一轮重试（注释里那段「否则该批消息既不落库又被去重吞掉」的坑，就是照抄的价值）。

**关于缓冲打包**：nc 是「连发源」——群里一条通知常被拆成好几段发，所以它先把同群消息攒进内存缓冲，静默满 3 分钟才合并投递（`dueGroups` / `assembleBatch` 两个纯函数）。
**如果你的来源是单条的（邮件、日历、单条推送），这一整块都不需要。**单发源的全部核心就这么点：

```ts
app.post("/api/sources/mysrc/event", async (req, reply) => {
  const body = z.object({ text: z.string().min(1) }).parse(req.body);
  ctx.ingest({
    content: body.text,
    sourceType: "mysrc",
    sourceIdentity: { sourceLabel: "我的来源" }, // 弹性字典：sourceLabel 必填，其余键随你
    eventTime: null,                              // 源自带时刻就填，没有就 null
  });
  return reply.code(200).send();
});
```

轮询型的来源同理：`register` 里用 `ctx.setInterval(拉取, 间隔)` 起个循环，拉到东西就 `ctx.ingest`——定时器会自动登记，core 关服时统一撤销，你不用自己 clear。

## 第 ③ 件 · settings：设置界面为什么自己长出表单

```ts
settings(): SettingField[] {
  return [
    { key: "groups", type: "record", label: "群白名单", description: "…" },
    { key: "windowMinutes", type: "number", label: "打包窗长（分钟）", default: 3, description: "…" },
  ];
}
```

设置项是**纯数据的声明**（六型：`text / number / boolean / select / record / secret`）。core 把它落库，前端按声明**自动渲染成表单**——前端根本不知道你叫什么名字。
读值用 `ctx.getSetting("windowMinutes")`，兜好默认值就行（用户在界面上清空某个键 = 回「未设置」，你的兜底逻辑会被直接触发）。没有可配的项，这个键就别写。

## 第 ④ 件 · stop：关服时的收尾

nc 的 `stop()` 把缓冲全部强制封批——尽力别丢消息。**你的源没有运行态，这个键就省略**。
`SIGINT` 不归你管：core 统一接信号 → 关服 → 依次调各源 `stop()`。

## 换成你自己的源（四步）

1. 建目录 `apps/server/src/sources/mysrc/`，抄 nc 的结构，改 `name` 和路由路径；
2. 把「收消息」那段换成你的来源（webhook / 轮询 / 随便什么——拿到内容就 `ctx.ingest`）；
3. `sources/registry.ts` 里加一行；
4. `npm run dev`，curl 一条试试，看板上出现事项 = 通了。

```bash
curl -X POST http://localhost:3001/api/sources/mysrc/event \
  -H "content-type: application/json" -d '{"text":"10月8日前交数据结构作业"}'
```

## 出问题时看哪里

- **日志**：`ctx.log` 打的东西在 stderr，带 `[source:你的名字]` 前缀；
- **状态**：`GET /api/sources` 里 core 帮你记着 `state / lastError`（出错不用自己维护面板）；
- **测试**：直接抄 `apps/server/src/test/nc.test.ts`（一个坑写在里面了：假时钟只假 `setInterval`，而且要在注册**之前**起）；
- **其它约定**（ingest 不抛、白名单类 fail-closed、重推幂等自己做……）都写在 `sources/types.ts` 的注释里——**照着接口来，不会错**。

---

<sub>完整接口 `apps/server/src/sources/types.ts` · 示例实现 `apps/server/src/sources/nc/` · 测试 `apps/server/src/test/nc.test.ts`</sub>
