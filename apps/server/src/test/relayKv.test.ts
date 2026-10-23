import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRegistryDb } from "../storage/registry";
import {
  deleteRelaySetting,
  getRelaySetting,
  listRelaySettingKeys,
  setRelaySetting,
} from "../storage/relay-kv";

// 部署级 KV（D-130）：Router 的凭据、绑定表、游标都存这。
// 它是「哑 KV」——只验证存取语义，不验证值的形状（形状归 Router 自己）。

const dirs: string[] = [];

/** 造一个临时系统库（afterEach 统一清）。 */
function tmpRegistry() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-relaykv-"));
  dirs.push(dir);
  return makeRegistryDb(path.join(dir, "system.db"));
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows 上 WAL 句柄可能仍占用——临时目录自会回收
    }
  }
});

describe("部署级 KV", () => {
  it("写入后可读回", () => {
    const db = tmpRegistry();
    setRelaySetting(db, "wecom.corpId", "ww123");
    expect(getRelaySetting(db, "wecom.corpId")).toBe("ww123");
    db.$client.close();
  });

  it("未设置 → null（与「存了空串」区分）", () => {
    const db = tmpRegistry();
    expect(getRelaySetting(db, "nope")).toBeNull();
    setRelaySetting(db, "empty", "");
    expect(getRelaySetting(db, "empty")).toBe(""); // 空串是有效值
    db.$client.close();
  });

  it("同键重复写 → 覆盖（UPSERT，不报错）", () => {
    const db = tmpRegistry();
    setRelaySetting(db, "k", "v1");
    setRelaySetting(db, "k", "v2");
    expect(getRelaySetting(db, "k")).toBe("v2");
    db.$client.close();
  });

  it("删除后可读回 null；删不存在的键不报错（幂等）", () => {
    const db = tmpRegistry();
    setRelaySetting(db, "k", "v");
    deleteRelaySetting(db, "k");
    expect(getRelaySetting(db, "k")).toBeNull();
    expect(() => deleteRelaySetting(db, "nope")).not.toThrow();
    db.$client.close();
  });

  it("键名列表按字典序（只列键、不列值——凭据在这些键里）", () => {
    const db = tmpRegistry();
    setRelaySetting(db, "wecom.secret", "s3cr3t");
    setRelaySetting(db, "bindings", "{}");
    setRelaySetting(db, "cursor:wecom", "abc");
    expect(listRelaySettingKeys(db)).toEqual(["bindings", "cursor:wecom", "wecom.secret"]);
    // 列表返回值里不含值本身（防止凭据被打进日志）
    expect(listRelaySettingKeys(db).join(",")).not.toContain("s3cr3t");
    db.$client.close();
  });

  it("跨开库持久（重启后还在）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-relaykv-p-"));
    dirs.push(dir);
    const file = path.join(dir, "system.db");
    const db1 = makeRegistryDb(file);
    setRelaySetting(db1, "persist", "yes");
    db1.$client.close();

    const db2 = makeRegistryDb(file);
    expect(getRelaySetting(db2, "persist")).toBe("yes");
    db2.$client.close();
  });
});
