import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRegistryDb, type RegistryDb } from "../storage/registry";
import { listRouterSettings, readRouterSetting, writeRouterSetting } from "../router/settings";

// Router 的部署级设置（D-130）：凭据与参数只走命令行，不进任何账户的设置页。
// 这些用例守两件事：①键名清单挡得住写错（写错 = 永远不生效的黑洞）；
// ②`router:list` 不会把凭据原样打出来。

const dirs: string[] = [];

/** 造一个临时系统库（afterEach 统一清）。 */
function tmpRegistry(): RegistryDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-routerset-"));
  dirs.push(dir);
  return makeRegistryDb(path.join(dir, "system.db"));
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows WAL 句柄——临时目录自会回收
    }
  }
});

describe("Router 部署级设置", () => {
  it("写入后读得到原文；未设置 → null（不是空串）", () => {
    const db = tmpRegistry();
    expect(readRouterSetting(db, "wecom.corpId")).toBeNull();
    writeRouterSetting(db, "wecom.corpId", "ww1234");
    expect(readRouterSetting(db, "wecom.corpId")).toBe("ww1234");
    db.$client.close();
  });

  it("写入空串 → 读回空串（「配了空值」与「没配」要能分辨）", () => {
    const db = tmpRegistry();
    writeRouterSetting(db, "wecom.secret", "");
    expect(readRouterSetting(db, "wecom.secret")).toBe("");
    db.$client.close();
  });

  it("未知键 → 拒绝并列出可用键（写错键名不许静默存进去）", () => {
    const db = tmpRegistry();
    expect(() => writeRouterSetting(db, "wecom.typo", "x")).toThrow("未知的 Router 设置项");
    expect(readRouterSetting(db, "wecom.typo")).toBeNull();
    db.$client.close();
  });

  it("list：全量列出已登记的键（未配置的如实说），凭据只露尾 4 位", () => {
    const db = tmpRegistry();
    writeRouterSetting(db, "wecom.corpId", "ww1234");
    writeRouterSetting(db, "wecom.secret", "abcdefgh-secret-9876");
    const rows = listRouterSettings(db);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    expect(byKey.get("wecom.corpId")).toBe("ww1234"); // 非凭据原样
    expect(byKey.get("wecom.secret")).toBe("****9876"); // 凭据掩码
    expect(byKey.get("wecom.openKfids")).toBe("（未配置）"); // 未配置如实说
    // 顺序 = 清单顺序（运维要能一眼看出还差哪几项）
    expect(rows.map((r) => r.key)).toEqual([
      "wecom.corpId",
      "wecom.secret",
      "wecom.callbackToken",
      "wecom.encodingAesKey",
      "wecom.openKfids",
      "wecom.replyThrottleMinutes",
    ]);
    db.$client.close();
  });

  it("短到没有 4 位可留的凭据 → 整串打码（别把短密码露出来）", () => {
    const db = tmpRegistry();
    writeRouterSetting(db, "wecom.secret", "ab");
    const row = listRouterSettings(db).find((r) => r.key === "wecom.secret");
    expect(row?.value).toBe("****");
    db.$client.close();
  });

  it("数值型设置写入即校验：空串 / 非数字 / 0 / 负数一律拒（D-103：错填当场判错）", () => {
    const db = tmpRegistry();
    for (const bad of ["", "  ", "10分钟", "abc", "0", "-5"]) {
      expect(() => writeRouterSetting(db, "wecom.replyThrottleMinutes", bad)).toThrow("必须是正数");
    }
    expect(readRouterSetting(db, "wecom.replyThrottleMinutes")).toBeNull(); // 一个都没写进去
    writeRouterSetting(db, "wecom.replyThrottleMinutes", "15");
    expect(readRouterSetting(db, "wecom.replyThrottleMinutes")).toBe("15");
    db.$client.close();
  });

  it("覆盖写生效（改凭据不用先删）", () => {
    const db = tmpRegistry();
    writeRouterSetting(db, "wecom.secret", "old");
    writeRouterSetting(db, "wecom.secret", "new");
    expect(readRouterSetting(db, "wecom.secret")).toBe("new");
    db.$client.close();
  });
});
