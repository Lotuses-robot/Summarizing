import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRegistryDb, type RegistryDb } from "../storage/registry";
import { setRelaySetting } from "../storage/relay-kv";
import { makeBindingStore } from "../router/store";

// 绑定表（D-130 / D-134）：外部标识 → uid，每个接入各持一份。
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
    const store = makeBindingStore(db, "wecom");
    store.set("wmAJ2", "uid-a");
    expect(store.resolve("wmAJ2")).toBe("uid-a");
    db.$client.close();
  });

  it("未绑定 → null（不是空串、不猜一个默认账户）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    expect(store.resolve("wmNever")).toBeNull();
    db.$client.close();
  });

  it("同一 id 改绑 → 覆盖，并留痕（不静默改归属）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    store.set("wmAJ2", "uid-a");
    store.set("wmAJ2", "uid-b");
    expect(store.resolve("wmAJ2")).toBe("uid-b");
    expect(spy.mock.calls.some(([msg]) => String(msg).includes("绑定覆盖"))).toBe(true);
    db.$client.close();
  });

  it("同一 uid 绑多个客户 → 允许（一个人可以有多个微信）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    store.set("wmA", "uid-a");
    store.set("wmB", "uid-a");
    expect(store.listAll()).toEqual([
      { code: "wmA", uid: "uid-a" },
      { code: "wmB", uid: "uid-a" },
    ]);
    db.$client.close();
  });

  it("空 external_userid / 空 uid → 不写（无意义的绑定）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    store.set("", "uid-a");
    store.set("wmA", "");
    expect(store.listAll()).toEqual([]);
    db.$client.close();
  });

  it("空串查询 → null（不命中任何绑定）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    store.set("wmA", "uid-a");
    expect(store.resolve("")).toBeNull();
    db.$client.close();
  });

  it("解除后查不到；解不存在的幂等", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    store.set("wmA", "uid-a");
    store.remove("wmA");
    expect(store.resolve("wmA")).toBeNull();
    expect(() => store.remove("wmA")).not.toThrow();
    db.$client.close();
  });

  it("存储里是坏 JSON → **抛错**（不兜底成空表——那会把所有客户判成未绑定）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    setRelaySetting(db, "bindings:wecom", "{不是合法 JSON");
    expect(() => store.resolve("wmA")).toThrow();
    expect(() => store.listAll()).toThrow();
    db.$client.close();
  });

  it("存储里是合法 JSON 但不是对象（如数组）→ 同样抛错", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    setRelaySetting(db, "bindings:wecom", '["not","a","map"]');
    expect(() => store.listAll()).toThrow();
    db.$client.close();
  });

  it("从未绑定时读 → 空表（初始态不是坏数据，不抛）", () => {
    const db = tmpRegistry();
    const store = makeBindingStore(db, "wecom");
    expect(store.listAll()).toEqual([]);
    expect(store.resolve("wmA")).toBeNull();
    db.$client.close();
  });
});
