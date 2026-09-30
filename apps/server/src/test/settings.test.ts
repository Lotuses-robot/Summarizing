import { describe, expect, it, vi } from "vitest";
import type { TaggedLlm } from "../shared/llm";
import { makeApp } from "../app";
import { makeDb } from "../storage/db";
import * as repo from "../storage/repo";

// 设置面板服务端（05§五 / D-81）：GET/PUT/DELETE ai + 备份。
// 全程不联网：makeOpenAiLlm 只建客户端不发请求，热切换用「引用身份变化」断言。

/** 造一个可替换的初始客户端引用。 */
function fakeRef(tag: string): { current: TaggedLlm } {
  return { current: { chat: async () => ({ content: null, toolCalls: [] }), modelTag: tag } };
}

describe("设置面板服务端（05§五 / D-81）", () => {
  it("PUT 热切换：引用换新、落库、视图掩码不回显完整 Key；DELETE 回 .env", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://env.example/v1");
    vi.stubEnv("OPENAI_MODEL", "env-model");
    const db = makeDb(":memory:");
    const llmRef = fakeRef("env-model");
    const before = llmRef.current;
    const app = makeApp({ db, llmRef });

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings/ai",
      payload: { baseUrl: "http://127.0.0.1:9/v1", model: "probe-model", apiKey: "sk-secret-9abc" },
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json<{
      overridden: boolean;
      model: string;
      apiKeyMasked: string | null;
    }>();
    expect(putBody.overridden).toBe(true);
    expect(putBody.model).toBe("probe-model");
    expect(putBody.apiKeyMasked).toBe("••••9abc"); // 只掩码，完整 Key 永不回显
    expect(llmRef.current).not.toBe(before); // 引用身份已换（无网络断言）
    expect(llmRef.current.modelTag).toBe("probe-model");
    expect(repo.getAppSetting(db, "ai")).not.toBeNull(); // 重启种子的数据源

    const del = await app.inject({ method: "DELETE", url: "/api/settings/ai" });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ overridden: boolean }>().overridden).toBe(false);
    expect(llmRef.current.modelTag).toBe("env-model"); // 热切回 .env（stub 的值）
    expect(repo.getAppSetting(db, "ai")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("DELETE 时 .env 缺配置 → 409、保旧客户端、覆盖不删（不静默不 500）", async () => {
    vi.stubEnv("OPENAI_BASE_URL", ""); // 钉死缺配置前提——不依赖运行机器的环境变量
    vi.stubEnv("OPENAI_MODEL", "");
    const db = makeDb(":memory:");
    const llmRef = fakeRef("probe-model");
    const app = makeApp({ db, llmRef });
    await app.inject({
      method: "PUT",
      url: "/api/settings/ai",
      payload: { baseUrl: "http://127.0.0.1:9/v1", model: "probe-model" },
    });

    const del = await app.inject({ method: "DELETE", url: "/api/settings/ai" });
    expect(del.statusCode).toBe(409);
    expect(llmRef.current.modelTag).toBe("probe-model"); // 旧客户端继续服务
    expect(repo.getAppSetting(db, "ai")).not.toBeNull(); // 覆盖原样保留
  });

  it("PUT 校验失败 → 400 且引用不换（切换原子：先建成客户端才换）", async () => {
    const db = makeDb(":memory:");
    const llmRef = fakeRef("env-model");
    const app = makeApp({ db, llmRef });

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/ai",
      payload: { baseUrl: "不是URL", model: "m" },
    });
    expect(res.statusCode).toBe(400);
    expect(llmRef.current.modelTag).toBe("env-model");
  });

  it("测试连接：校验失败 → 400（ok 路径需真实网关，交走查验证）", async () => {
    const db = makeDb(":memory:");
    const llmRef = fakeRef("t");
    const app = makeApp({ db, llmRef });

    const res = await app.inject({
      method: "POST",
      url: "/api/settings/ai/test",
      payload: { baseUrl: "不是URL", model: "m" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("备份：GET /api/backup 回附件流，内容是合法 SQLite 文件", async () => {
    const db = makeDb(":memory:");
    const llmRef = fakeRef("t");
    const app = makeApp({ db, llmRef });

    const res = await app.inject({ method: "GET", url: "/api/backup" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("summarizing.db");
    expect(res.body.slice(0, 15)).toBe("SQLite format 3"); // SQLite 文件头
  });
});
