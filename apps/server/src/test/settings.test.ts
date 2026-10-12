import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAllTestAccounts, makeTestAccount } from "./helpers/app";
import * as repo from "../storage/repo";

// 设置面板服务端（05§五 / D-81；006 起经 makeTestAccount 打真实入口）：GET/PUT/DELETE ai + 备份。
// 全程不联网：makeOpenAiLlm 只建客户端不发请求，热切换用「引用身份变化」断言。
// 006 变更：llmRef 在**空间**里（每人自带 key）——测试直取 t.space.llmRef。

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupAllTestAccounts();
});

describe("设置面板服务端（05§五 / D-81）", () => {
  it("PUT 热切换：引用换新、落库、视图掩码不回显完整 Key；DELETE 回「未配置」（无 .env 可回）", async () => {
    const t = await makeTestAccount();
    const llmRef = t.space.llmRef;
    const before = llmRef.current;

    const put = await t.inject({
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
    expect(repo.getAppSetting(t.db, "ai")).not.toBeNull(); // 重启种子的数据源

    const del = await t.inject({ method: "DELETE", url: "/api/settings/ai" });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ overridden: boolean }>().overridden).toBe(false);
    // 006：无 .env 可回——DELETE 即回「未配置」占位客户端（多用户每人自带 key）
    expect(llmRef.current.modelTag).toBe("未配置");
    expect(repo.getAppSetting(t.db, "ai")).toBeNull();
  });

  it("未配 AI 的账户：视图为空、PUT 空 baseUrl → 400（不再有 .env 兜底）", async () => {
    const t = await makeTestAccount();
    const get = await t.inject({ method: "GET", url: "/api/settings/ai" });
    expect(get.json<{ overridden: boolean; baseUrl: string }>()).toMatchObject({
      overridden: false,
      baseUrl: "",
    });
    // 空 baseUrl 建客户端直接抛 → 400（无 .env 可顶上）
    const put = await t.inject({
      method: "PUT",
      url: "/api/settings/ai",
      payload: { baseUrl: "", model: "m" },
    });
    expect(put.statusCode).toBe(400);
  });

  it("PUT 校验失败 → 400 且引用不换（切换原子：先建成客户端才换）", async () => {
    const t = await makeTestAccount();
    const llmRef = t.space.llmRef;
    const before = llmRef.current;

    const res = await t.inject({
      method: "PUT",
      url: "/api/settings/ai",
      payload: { baseUrl: "不是URL", model: "m" },
    });
    expect(res.statusCode).toBe(400);
    expect(llmRef.current).toBe(before);
  });

  it("测试连接：校验失败 → 400（ok 路径需真实网关，交走查验证）", async () => {
    const t = await makeTestAccount();
    const res = await t.inject({
      method: "POST",
      url: "/api/settings/ai/test",
      payload: { baseUrl: "不是URL", model: "m" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("备份：GET /api/backup 回附件流，内容是当前账户库的合法 SQLite 文件", async () => {
    const t = await makeTestAccount();
    const res = await t.inject({ method: "GET", url: "/api/backup" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("summarizing.db");
    expect(res.body.slice(0, 15)).toBe("SQLite format 3"); // SQLite 文件头
  });
});
