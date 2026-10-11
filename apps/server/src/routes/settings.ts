import {
  AiSettingsSchema,
  AiSettingsViewSchema,
  AiTestResultSchema,
  errText,
  type AiSettingsView,
} from "@summarizing/shared";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { envFromAiSettings, makeOpenAiLlm, type TaggedLlm } from "../shared/llm";

// settings 资源路由（05§五 / D-81；006 起依赖来自请求上下文）：AI 设置的读改清 + 测试连接 +
// 数据备份下载。库与 llm 引用都从 req.space 取——AI key 每人自带（本批定制）。
// 原则「用户偏好进设置，系统策略进代码」——这张表只放用户偏好。
// 存量 AI 解析（readStoredAi）与键名住 storage/repo（单一出处，空间装配共用）。

/** Key 掩码（末 4 位）；没配就是 null——不回显完整 Key（05§五「Key 明文知情」≠明文回显）。
 *  超短 key（≤4 位）掩码会整体泄露，回固定掩码。 */
function maskKey(key: string | undefined): string | null {
  if (key === undefined || key === "") return null;
  if (key.length <= 4) return "••••••••";
  return `••••${key.slice(-4)}`;
}

/** 组 GET 响应视图：覆盖在 = 设置值；否则 .env 现值。 */
function view(db: Db): AiSettingsView {
  const stored = repo.readStoredAi(db);
  const src = stored ?? {
    baseUrl: process.env.OPENAI_BASE_URL ?? "",
    model: process.env.OPENAI_MODEL ?? "",
    apiKey: process.env.OPENAI_API_KEY,
  };
  return AiSettingsViewSchema.parse({
    baseUrl: src.baseUrl,
    model: src.model,
    apiKeyMasked: maskKey(src.apiKey),
    overridden: stored !== null,
  });
}

/** 注册 settings 路由（GET/PUT/DELETE ai、POST ai/test、GET backup）。 */
export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings/ai", async (req) => view(req.space.db));

  // 保存即热切换（05§五）：先建新客户端成功才换+落库，失败保旧——切换是原子的
  app.put("/api/settings/ai", async (req, reply) => {
    const parsed = AiSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const db = req.space.db;
    const stored = repo.readStoredAi(db);
    // 显式空串 = 没填：沿用现值，不把 "" 当 key 存库
    const incoming = parsed.data.apiKey === "" ? undefined : parsed.data.apiKey;
    const apiKey = incoming ?? stored?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    let next: TaggedLlm;
    try {
      next = makeOpenAiLlm(envFromAiSettings({ ...parsed.data, apiKey }));
    } catch (err) {
      return reply.code(400).send({ error: errText(err) });
    }
    // 落库（唯一可失败步骤）成功后才换引用——任一步失败都保持旧一致状态
    repo.setAppSetting(db, repo.AI_SETTINGS_KEY, JSON.stringify({ ...parsed.data, apiKey }));
    req.space.llmRef.current = next;
    return view(db);
  });

  // 清除覆盖（05§五）：回 .env 种子并热切回去。
  // 与 PUT 同款原子性——先建成 .env 客户端才换+删；.env 缺配置就保旧客户端继续服务，如实相告不 500。
  app.delete("/api/settings/ai", async (req, reply) => {
    let restored: TaggedLlm;
    try {
      restored = makeOpenAiLlm();
    } catch (err) {
      return reply.code(409).send({ error: `.env 缺少 AI 配置，无法回退：${errText(err)}` });
    }
    repo.deleteAppSetting(req.space.db, repo.AI_SETTINGS_KEY);
    req.space.llmRef.current = restored;
    return view(req.space.db);
  });

  // 测试连接（05§五）：用「表单值」建一次性客户端发最小请求，量延迟；不动当前 llmRef
  app.post("/api/settings/ai/test", async (req, reply) => {
    const parsed = AiSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const stored = repo.readStoredAi(req.space.db);
    const incoming = parsed.data.apiKey === "" ? undefined : parsed.data.apiKey;
    const apiKey = incoming ?? stored?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    const started = Date.now();
    try {
      const probe = makeOpenAiLlm(envFromAiSettings({ ...parsed.data, apiKey }), 15_000);
      await probe.chat({
        system: "你是连通性探针。收到任何消息都只回复 OK。",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
      });
      return AiTestResultSchema.parse({ ok: true, latencyMs: Date.now() - started });
    } catch (err) {
      return AiTestResultSchema.parse({ ok: false, error: errText(err) });
    }
  });

  // 一键备份（05§五；006 语义 = 备份**当前账户自己的库**）：better-sqlite3 在线备份（WAL 安全）
  // → 下载后删临时文件；uuid 命名防同毫秒并发撞名，备份失败也清理半成品
  app.get("/api/backup", async (req, reply) => {
    const tmp = path.join(os.tmpdir(), `summarizing-backup-${randomUUID()}.db`);
    try {
      await req.space.db.$client.backup(tmp);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", 'attachment; filename="summarizing.db"');
    const stream = createReadStream(tmp);
    stream.on("close", () => rmSync(tmp, { force: true }));
    return reply.send(stream);
  });
}
