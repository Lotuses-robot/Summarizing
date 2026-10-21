import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SettingFieldSchema, SourceSummarySchema, type SettingField } from "@summarizing/shared";
import * as repo from "../storage/repo";

// 信源设置路由（D-84/D-88；006 起依赖来自请求上下文）：core 只知道「有什么设置」，不解释内容——
// 通用 KV 读写口。值是任意 JSON；库与状态表都从 req.space 取（每个账户一套自己的信源）。
// `__schema__` 保留键住 storage/repo（host 写、此处读并过滤——单一出处）。

const NameParamsSchema = z.object({ name: z.string().min(1) });
const KeyParamsSchema = z.object({ name: z.string().min(1), key: z.string().min(1) });

/** 把存储的 JSON 串读回值；坏串原样返回（core 不解释也不静默丢——读得到原串就能发现坏了）。 */
function parseStored(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
}

/** 解析 `__schema__` 里存的设置声明；缺失/坏 → 空数组（无设置的源）。
 *  逐条过 schema（不信库里存的东西——手改/旧版可能坏形）；坏条目丢弃但**留痕**（不静默，
 *  否则一个字段会无声从设置界面消失——评审发现）。落库前已在 registerSources 过一遍校验，
 *  这里只剩「手改库/旧库」的兜底。 */
function parseSchema(source: string, text: string | null): SettingField[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    process.stderr.write(`[source:${source}] __schema__ 不是合法 JSON，按无设置处理\n`);
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SettingField[] = [];
  for (const item of raw) {
    const parsed = SettingFieldSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else process.stderr.write(`[source:${source}] 丢弃坏形设置声明：${JSON.stringify(item)}\n`);
  }
  return out;
}

/** 注册信源路由：GET 列表+schema+接入路径（前端不知道信源名，按 schema 渲染）/ GET 全键值 / PUT 单键 / DELETE 单键。 */
export function registerSourceRoutes(app: FastifyInstance): void {
  // 列表：每个信源的名字、运行状态（含最近错误）、设置 schema、**完整接入地址**（hookPath，已含
  // 账户令牌——URL 形状是源自己的知识，由后端算好，前端零拼接；006 用户走查定）。
  app.get("/api/sources", async (req) => {
    const states = req.space.sourceStates;
    const names = new Set<string>(states.keys());
    for (const row of repo.listSourceNames(req.space.db)) names.add(row);
    const token = req.space.sourceToken;
    return [...names].map((name) => {
      // 取该源首个登记的 webhook 路径（本批 nc 仅 /event；多入口源各自成行属下一批）
      const route = req.space.webhookRoutes.find((r) => r.source === name);
      return SourceSummarySchema.parse({
        name,
        state: states.get(name)?.state ?? "ok",
        lastError: states.get(name)?.lastError,
        lastErrorAt: states.get(name)?.lastErrorAt,
        // 活动信号：声明与时刻全部来自适配器，core 只搬运（D-115）
        activity: (states.get(name)?.signals ?? []).map((s) => ({
          label: s.label,
          at: states.get(name)?.activity[s.key],
        })),
        guide: states.get(name)?.guide,
        settings: parseSchema(
          name,
          repo.getSourceSetting(req.space.db, name, repo.SOURCE_SCHEMA_KEY),
        ),
        hookPath: route ? `/hook/${token}/${name}${route.path}` : null,
      });
    });
  });

  app.get("/api/sources/:name/settings", async (req) => {
    const { name } = NameParamsSchema.parse(req.params);
    const out: Record<string, unknown> = {};
    for (const row of repo.listSourceSettings(req.space.db, name)) {
      if (row.key === repo.SOURCE_SCHEMA_KEY) continue; // schema 不属于设置值，不回吐
      out[row.key] = parseStored(row.value);
    }
    return out;
  });

  app.put("/api/sources/:name/settings/:key", async (req, reply) => {
    const { name, key } = KeyParamsSchema.parse(req.params);
    // 请求体 = 任意 JSON 值（对象/标量/null 都合法——core 不解释）；只有「无 body」拒收。
    // ⚠️ 不能用 === null 判空：JSON 字面量 null 是合法设置值，二者 fastify 表现不同
    if (req.body === undefined) {
      return reply.code(400).send({ error: "请求体必须是 JSON 值" });
    }
    repo.setSourceSetting(req.space.db, name, key, JSON.stringify(req.body));
    return reply.code(204).send();
  });

  app.delete("/api/sources/:name/settings/:key", async (req, reply) => {
    const { name, key } = KeyParamsSchema.parse(req.params);
    repo.deleteSourceSetting(req.space.db, name, key);
    return reply.code(204).send();
  });
}
