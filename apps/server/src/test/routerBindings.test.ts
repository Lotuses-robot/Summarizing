import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRegistryDb, type RegistryDb } from "../storage/registry";
import { setRelaySetting } from "../storage/relay-kv";
import { listBindings, removeBinding, resolveBinding, setBinding } from "../router/bindings";

// 绑定表（D-130）：external_userid → uid。
// Phase 0 的五种脏形态逐条覆盖（spec 的「边界与脏形态」表）。

const dirs: string[] = [];

/** 造一个临时系统库（afterEach 统一清）。 */
function tmpRegistry(): RegistryDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "summarizing-bind-"));
  dirs.push(dir);
  return makeRegistryDb(path.join(dir, "system.db"));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows WAL 句柄——临时目录自会回收
    }
  }
});

describe("绑定表", () => {
  it("建立后能查到", () => {
    const db = tmpRegistry();
    setBinding(db, "wmAJ2", "uid-a");
    expect(resolveBinding(db, "wmAJ2")).toBe("uid-a");
    db.$client.close();
  });

  it("未绑定 → null（不是空串、不猜一个默认账户）", () => {
    const db = tmpRegistry();
    expect(resolveBinding(db, "wmNever")).toBeNull();
    db.$client.close();
  });

  it("同一 id 改绑 → 覆盖，并留痕（不静默改归属）", () => {
    const db = tmpRegistry();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setBinding(db, "wmAJ2", "uid-a");
    setBinding(db, "wmAJ2", "uid-b");
    expect(resolveBinding(db, "wmAJ2")).toBe("uid-b");
    expect(spy.mock.calls.some(([msg]) => String(msg).includes("绑定覆盖"))).toBe(true);
    db.$client.close();
  });

  it("同一 uid 绑多个客户 → 允许（一个人可以有多个微信）", () => {
    const db = tmpRegistry();
    setBinding(db, "wmA", "uid-a");
    setBinding(db, "wmB", "uid-a");
    expect(listBindings(db)).toEqual([
      { externalUserId: "wmA", uid: "uid-a" },
      { externalUserId: "wmB", uid: "uid-a" },
    ]);
    db.$client.close();
  });

  it("空 external_userid / 空 uid → 不写（无意义的绑定）", () => {
    const db = tmpRegistry();
    setBinding(db, "", "uid-a");
    setBinding(db, "wmA", "");
    expect(listBindings(db)).toEqual([]);
    db.$client.close();
  });

  it("空串查询 → null（不命中任何绑定）", () => {
    const db = tmpRegistry();
    setBinding(db, "wmA", "uid-a");
    expect(resolveBinding(db, "")).toBeNull();
    db.$client.close();
  });

  it("解除后查不到；解不存在的幂等", () => {
    const db = tmpRegistry();
    setBinding(db, "wmA", "uid-a");
    removeBinding(db, "wmA");
    expect(resolveBinding(db, "wmA")).toBeNull();
    expect(() => removeBinding(db, "wmA")).not.toThrow();
    db.$client.close();
  });

  it("存储里是坏 JSON → **抛错**（不兜底成空表——那会把所有客户判成未绑定）", () => {
    const db = tmpRegistry();
    setRelaySetting(db, "bindings", "{不是合法 JSON");
    expect(() => resolveBinding(db, "wmA")).toThrow();
    expect(() => listBindings(db)).toThrow();
    db.$client.close();
  });

  it("存储里是合法 JSON 但不是对象（如数组）→ 同样抛错", () => {
    const db = tmpRegistry();
    setRelaySetting(db, "bindings", '["not","a","map"]');
    expect(() => listBindings(db)).toThrow();
    db.$client.close();
  });

  it("从未绑定时读 → 空表（初始态不是坏数据，不抛）", () => {
    const db = tmpRegistry();
    expect(listBindings(db)).toEqual([]);
    expect(resolveBinding(db, "wmA")).toBeNull();
    db.$client.close();
  });
});
