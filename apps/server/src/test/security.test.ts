import { afterEach, describe, expect, it } from "vitest";
import { cleanupAllTestAccounts, makeTestAccount } from "./helpers/app";
import { redactHookUrl } from "../app";

// 安全基线套件（006 T040）：基础安全响应头（含 401 面）+ 日志 URL 脱敏单测。
// 端到端证据（真实日志行里出现 /hook/***/…）在 nc/gateway 用例的运行日志中可见。

afterEach(cleanupAllTestAccounts);

describe("基础安全响应头（FR-008 / 安全审视）", () => {
  it("200 与 401 面都带头：nosniff / Referrer-Policy / X-Frame-Options / API no-store", async () => {
    const t = await makeTestAccount();

    const ok = await t.inject({ method: "GET", url: "/api/board" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["referrer-policy"]).toBe("same-origin");
    expect(ok.headers["x-frame-options"]).toBe("DENY");
    expect(ok.headers["cache-control"]).toBe("no-store");

    const unauth = await t.app.inject({ method: "GET", url: "/api/board" }); // 无 cookie
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers["x-content-type-options"]).toBe("nosniff");
    expect(unauth.headers["referrer-policy"]).toBe("same-origin");
    expect(unauth.headers["x-frame-options"]).toBe("DENY");
    expect(unauth.headers["cache-control"]).toBe("no-store");
  });
});

describe("日志 URL 脱敏（FR-008：令牌不进日志明文）", () => {
  it("redactHookUrl：令牌段整体替换；非 /hook 路径原样", () => {
    expect(redactHookUrl("/hook/abc123def456/echo/ingest")).toBe("/hook/***/echo/ingest");
    expect(redactHookUrl("/hook/abc123def456?x=1")).toBe("/hook/***?x=1");
    expect(redactHookUrl("/hook/abc123def456")).toBe("/hook/***");
    expect(redactHookUrl("/api/board")).toBe("/api/board");
    expect(redactHookUrl("/hook")).toBe("/hook");
  });
});
