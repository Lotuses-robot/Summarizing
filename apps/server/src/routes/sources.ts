import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SettingFieldSchema, SourceSummarySchema, type SettingField } from "@summarizing/shared";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import type { SourceState } from "../sources/types";

// 信源设置路由（D-84/D-88）：core 只知道「有什么设置」，不解释内容——通用 KV 读写口。
// 值是任意 JSON；联调期 curl 改白名单/窗长（docs/07 检查单③），设置界面随后端端点之后的前端批次。

/** 信源声明的设置 schema 在设置 KV 里的保留键——不属于「设置值」，读值端点须过滤掉（D-88 T3）。 */
export const SOURCE_SCHEMA_KEY = "__schema__";

const NameParamsSchema = z.object({ name: z.string().min(1) });
const KeyParamsSchema = z.object({ name: z.string().min(1), key: z.string().min(1) });

/** 本组路由的窄依赖（不 import app.ts → 无循环）。 */
export interface SourceRouteDeps {
  db: Db;
  /** 信源状态表（makeApp 挂空表，registerSources 填充）——`GET /api/sources` 读它。 */
  sourceStates: Map<string, SourceState>;
}

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

/** 注册信源路由：GET 列表+schema（前端不知道信源名，按 schema 渲染）/ GET 全键值 / PUT 单键 / DELETE 单键。 */
export function registerSourceRoutes(app: FastifyInstance, deps: SourceRouteDeps): void {
  // 列表：每个信源的名字、运行状态（含最近错误）、设置 schema——前端据此渲染通用设置表单
  //（core 不解释内容）。仅在库里有设置行、未上岗的源按 ok 兜底（乐观；UI 收口可给第三态）。
  app.get("/api/sources", async () => {
    const names = new Set<string>(deps.sourceStates.keys());
    for (const row of repo.listSourceNames(deps.db)) names.add(row);
    return [...names].map((name) =>
      SourceSummarySchema.parse({
        name,
        state: deps.sourceStates.get(name)?.state ?? "ok",
        lastError: deps.sourceStates.get(name)?.lastError,
        lastOkAt: deps.sourceStates.get(name)?.lastOkAt,
        settings: parseSchema(name, repo.getSourceSetting(deps.db, name, SOURCE_SCHEMA_KEY)),
      }),
    );
  });

  app.get("/api/sources/:name/settings", async (req) => {
    const { name } = NameParamsSchema.parse(req.params);
    const out: Record<string, unknown> = {};
    for (const row of repo.listSourceSettings(deps.db, name)) {
      if (row.key === SOURCE_SCHEMA_KEY) continue; // schema 不属于设置值，不回吐
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
    repo.setSourceSetting(deps.db, name, key, JSON.stringify(req.body));
    return reply.code(204).send();
  });

  app.delete("/api/sources/:name/settings/:key", async (req, reply) => {
    const { name, key } = KeyParamsSchema.parse(req.params);
    repo.deleteSourceSetting(deps.db, name, key);
    return reply.code(204).send();
  });
}
