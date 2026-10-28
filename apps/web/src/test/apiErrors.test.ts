import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, isUnauthorized } from "../api";
import { jsonResponse } from "./helpers/http";

// web 端错误文案口径（api.ts 的 apiErrorText）：4xx 说人话；5xx 不透传服务端异常原文。

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 造一个固定状态码与响应体的 fetch 替身。 */
function stub(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(body, status))),
  );
}

describe("api 错误文案", () => {
  it("4xx：Fastify 的 message 就是给人看的话——照实显示", async () => {
    stub(413, {
      statusCode: 413,
      error: "Payload Too Large",
      message: "图片超过大小上限（20 MiB）",
    });
    await expect(api.board({ page: 1, folded: false })).rejects.toThrow(
      "图片超过大小上限（20 MiB）",
    );
  });

  it("4xx：自定义 {error} 照实显示", async () => {
    stub(400, { error: "不是支持的图片格式（image/png）" });
    await expect(api.board({ page: 1, folded: false })).rejects.toThrow(
      "不是支持的图片格式（image/png）",
    );
  });

  it('401 带状态码（判「未登录」靠它，不靠文案里有没有 "401"）', async () => {
    // 服务端 401 回的是 {"error":"未登录"}——文案里根本没有 "401"。
    // 曾经 App 用 `errText(err).includes("401")` 判登录态 → 首屏永远被误判成「后端没起来」。
    stub(401, { error: "未登录" });
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isUnauthorized(err)).toBe(true);
    expect((err as ApiError).status).toBe(401);
  });

  it("网络故障（不是 HTTP 响应）→ isUnauthorized 为 false（那才是后端没起来）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const err = await api.me().catch((e: unknown) => e);
    expect(isUnauthorized(err)).toBe(false);
  });

  it("5xx：异常原文（SQL/文件路径）不透传到界面", async () => {
    stub(500, {
      statusCode: 500,
      error: "Internal Server Error",
      message: "SQLITE_ERROR: no such table: items",
    });
    await expect(api.board({ page: 1, folded: false })).rejects.toThrow("请求失败 500");
  });
});
