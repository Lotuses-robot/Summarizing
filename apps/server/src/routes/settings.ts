import {
  AiSettingsSchema,
  AiSettingsViewSchema,
  AiTestResultSchema,
  RejectionRulesSchema,
  RejectionRulesViewSchema,
  errText,
  type AiSettings,
  type AiSettingsView,
} from "@summarizing/shared";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../storage/db";
import * as repo from "../storage/repo";
import { makeOpenAiLlm, makeUnconfiguredLlm, type TaggedLlm } from "../shared/llm";

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

/** 组 GET 响应视图：本账户设置值（无则空——006 起无 .env 兜底，未配即「未配置」）。
 *  overridden = **配得全**（baseUrl 与 model 都在）——不是「存过行」：半配置/坏配置不该冒充已配置。 */
function view(db: Db): AiSettingsView {
  const stored = repo.readStoredAi(db);
  const configured = stored !== null && stored.baseUrl !== "" && stored.model !== "";
  return AiSettingsViewSchema.parse({
    baseUrl: stored?.baseUrl ?? "",
    model: stored?.model ?? "",
    apiKeyMasked: maskKey(stored?.apiKey),
    overridden: configured,
  });
}

/** 由表单值 + 存量合成完整 AI 配置（apiKey 空串 = 沿用存量；不把 "" 当 key）。 */
function mergeAiConfig(form: AiSettings, stored: AiSettings | null): AiSettings {
  const incoming = form.apiKey === "" ? undefined : form.apiKey;
  const apiKey = incoming ?? stored?.apiKey;
  return {
    baseUrl: form.baseUrl,
    model: form.model,
    ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
  };
}

/** PUT /api/settings/rejection-rules 的请求体形状（zod 校验，不用 as 担保）。 */
const RejectionRulesBodySchema = z.object({ rules: RejectionRulesSchema });

/** 注册 settings 路由（GET/PUT/DELETE ai、POST ai/test、GET/PUT rejection-rules、GET backup）。 */
export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings/ai", async (req) => view(req.space.db));

  // 用户拒收规则（D-107）：读（原样回显）/ 写（整段覆盖，无结构化解析——用户自由文本）
  app.get("/api/settings/rejection-rules", async (req) => {
    return RejectionRulesViewSchema.parse({ rules: repo.readRejectionRules(req.space.db) });
  });

  app.put("/api/settings/rejection-rules", async (req, reply) => {
    // 形状校验走 zod（不用 `as` 向编译器担保——项目类型红线）；body 形状单一出处
    const parsed = RejectionRulesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "请求体不合法",
        issues: parsed.error.issues.map((i) => ({ message: i.message })),
      });
    }
    // 空串 = 清空规则：存空串而不是删行（读路径对「行缺失」与「空串」同一视之，删行也行——
    // 但存空串让「用户设过又清了」与「从没设过」在库里可分辨，便于排查）
    repo.setAppSetting(req.space.db, repo.REJECTION_RULES_KEY, JSON.stringify(parsed.data.rules));
    return RejectionRulesViewSchema.parse({ rules: parsed.data.rules });
  });

  // 保存即热切换（05§五）：先建新客户端成功才换+落库，失败保旧——切换是原子的
  app.put("/api/settings/ai", async (req, reply) => {
    const parsed = AiSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const db = req.space.db;
    const config = mergeAiConfig(parsed.data, repo.readStoredAi(db));
    let next: TaggedLlm;
    try {
      next = makeOpenAiLlm(config);
    } catch (err) {
      return reply.code(400).send({ error: errText(err) });
    }
    // 落库（唯一可失败步骤）成功后才换引用——任一步失败都保持旧一致状态
    repo.setAppSetting(db, repo.AI_SETTINGS_KEY, JSON.stringify(config));
    req.space.llmRef.current = next;
    return view(db);
  });

  // 清除设置（05§五）：本账户回到「未配置」并热切占位客户端——无 .env 可回（006 每人自带 key）。
  app.delete("/api/settings/ai", async (req) => {
    repo.deleteAppSetting(req.space.db, repo.AI_SETTINGS_KEY);
    req.space.llmRef.current = makeUnconfiguredLlm();
    return view(req.space.db);
  });

  // 测试连接（05§五）：用「表单值」建一次性客户端发最小请求，量延迟；不动当前 llmRef
  app.post("/api/settings/ai/test", async (req, reply) => {
    const parsed = AiSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求体不合法", issues: parsed.error.issues });
    }
    const config = mergeAiConfig(parsed.data, repo.readStoredAi(req.space.db));
    const started = Date.now();
    try {
      const probe = makeOpenAiLlm(config, 15_000);
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
