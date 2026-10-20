import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { MediaUploadResponseSchema, errText } from "@summarizing/shared";
import { eq } from "drizzle-orm";
import { media as mediaTable } from "../storage/schema";
import { readMediaBytes, storeImageBytes } from "../application/media";

// 媒体路由（009）：POST 上传（前台对话 + 信源图片的统一入口）、GET 按 sha256 读回。
// 归属隔离靠**受保护作用域**：space 已定账户，media 表在该账户自己的库里——别人的 id 在本库
// 查不到 → 404（与「不存在」同形，不泄露图片存在性；同 image 类端点的通行做法）。
// 读取响应：private（不进共享缓存）+ immutable（内容寻址，字节永不改，重传零成本）。

/** 上传 body 上限（与 shared 的 MEDIA_MAX_INPUT_BYTES 同值；这里由 Fastify 先截断）。 */
const BODY_LIMIT = 20 * 1024 * 1024;

/** 注册媒体路由（受保护面）。 */
export function registerMediaRoutes(app: FastifyInstance): void {
  // 上传：原始字节体（不引 multipart 依赖——单字段场景自己解析更省）。
  // content-type 只在这条路由挂 image/*，其余路由保持 JSON 默认（挂全局会误伤 /api/ingest 等）。
  app.post("/api/media", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const declared = req.headers["content-type"] ?? "";
    const raw: unknown = req.body;
    // Fastify 的 raw body 给 Buffer；测试替身可能给字符串——两者都接受（Buffer 更省一次拷贝）
    if (!Buffer.isBuffer(raw) && typeof raw !== "string") {
      return reply.code(400).send({ error: "请求体必须是图片原始字节" });
    }
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    try {
      const stored = await storeImageBytes(req.space.db, req.space.mediaDir, bytes, {
        declaredMime: declared,
      });
      return MediaUploadResponseSchema.parse({
        id: stored.id,
        url: `/api/media/${stored.id}`,
        mime: stored.mime,
        sizeBytes: stored.sizeBytes,
        animationCompressed: stored.animationCompressed,
      });
    } catch (err) {
      return reply.code(400).send({ error: errText(err) });
    }
  });

  // 读回：行在才读文件；文件缺失也 404（清理器或手工删过）
  app.get("/api/media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = req.space.db
      .select({ mime: mediaTable.mime })
      .from(mediaTable)
      .where(eq(mediaTable.id, id))
      .get();
    if (row === undefined) return reply.code(404).send({ error: "图片不存在" });
    try {
      const bytes = readMediaBytes(req.space.mediaDir, id, row.mime);
      return reply
        .header("Content-Type", row.mime)
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    } catch {
      return reply.code(404).send({ error: "图片文件缺失" });
    }
  });
}

/** 本账户的媒体目录（装配期调用一次；mkdir 幂等）。 */
export function makeMediaDir(dataRoot: string, uid: string): string {
  const dir = path.join(dataRoot, "media", uid);
  mkdirSync(dir, { recursive: true });
  return dir;
}
