import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
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
    await expect(api.board()).rejects.toThrow("图片超过大小上限（20 MiB）");
  });

  it("4xx：自定义 {error} 照实显示", async () => {
    stub(400, { error: "不是支持的图片格式（image/png）" });
    await expect(api.board()).rejects.toThrow("不是支持的图片格式（image/png）");
  });

  it("5xx：异常原文（SQL/文件路径）不透传到界面", async () => {
    stub(500, {
      statusCode: 500,
      error: "Internal Server Error",
      message: "SQLITE_ERROR: no such table: items",
    });
    await expect(api.board()).rejects.toThrow("请求失败 500");
  });
});
