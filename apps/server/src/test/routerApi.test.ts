import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAllTestAccounts,
  makeTestRealm,
  type TestRealm,
  type TestAccount,
} from "./helpers/app";
import { listBindings, setBinding } from "../router/bindings";

// 账户侧的 Router 入口（D-130）：`GET /api/router`、`PUT /api/router/bindings`、`PUT /api/router/enabled`。
//
// 这一层的验收点是**隔离**：一个账户只能看见/改动自己的绑定——绑定表是部署级的，
// 而「谁能改哪几行」必须由会话（uid）决定，不能由请求体说了算。

afterEach(async () => {
  await cleanupAllTestAccounts();
});

/** 造一个带两个账户的实例（隔离用例需要同实例多账户）。 */
async function twoAccounts(): Promise<{ realm: TestRealm; a: TestAccount; b: TestAccount }> {
  const realm = await makeTestRealm();
  const a = await realm.addAccount({ username: "alpha" });
  const b = await realm.addAccount({ username: "beta" });
  return { realm, a, b };
}

describe("Router 账户侧：读视图", () => {
  it("新账户：默认接收（enabled），绑定为空", async () => {
    const { a } = await twoAccounts();
    const res = await a.inject({ method: "GET", url: "/api/router" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, bindings: [] });
  });

  it("只列**我**的绑定码（别人的看不到）", async () => {
    const { realm, a, b } = await twoAccounts();
    setBinding(realm.registry, "cust-A1", a.space.uid);
    setBinding(realm.registry, "cust-B1", b.space.uid);

    const res = await a.inject({ method: "GET", url: "/api/router" });
    expect(res.json()).toEqual({ enabled: true, bindings: ["cust-A1"] });
  });

  it("一个账户可以有多个绑定码（一个人多个微信），按字典序列出", async () => {
    const { realm, a } = await twoAccounts();
    setBinding(realm.registry, "cust-Z", a.space.uid);
    setBinding(realm.registry, "cust-A", a.space.uid);

    const res = await a.inject({ method: "GET", url: "/api/router" });
    expect(res.json()).toEqual({ enabled: true, bindings: ["cust-A", "cust-Z"] });
  });
});

describe("Router 账户侧：写绑定码", () => {
  it("整段覆盖：新码绑到我，删掉的码解绑", async () => {
    const { realm, a } = await twoAccounts();
    setBinding(realm.registry, "old-code", a.space.uid);

    const res = await a.inject({
      method: "PUT",
      url: "/api/router/bindings",
      payload: { bindings: ["new-code"] },
    });
    expect(res.statusCode).toBe(200);

    const view = await a.inject({ method: "GET", url: "/api/router" });
    expect(view.json()).toEqual({ enabled: true, bindings: ["new-code"] });
    // 「old-code」已整个解绑
    expect(listBindings(realm.registry).map((x) => x.externalUserId)).not.toContain("old-code");
  });

  it("只能改自己那份：提交别人的码会把它**改绑**过来（后写为准），但不会动自己原有的码", async () => {
    const { realm, a, b } = await twoAccounts();
    setBinding(realm.registry, "cust-B1", b.space.uid);
    setBinding(realm.registry, "cust-A1", a.space.uid);

    await a.inject({
      method: "PUT",
      url: "/api/router/bindings",
      payload: { bindings: ["cust-A1", "cust-B1"] },
    });

    const byCode = new Map(listBindings(realm.registry).map((x) => [x.externalUserId, x.uid]));
    expect(byCode.get("cust-A1")).toBe(a.space.uid);
    expect(byCode.get("cust-B1")).toBe(a.space.uid); // 改绑过来了
  });

  it("提交空数组 → 我名下全解绑（别人的不动）", async () => {
    const { realm, a, b } = await twoAccounts();
    setBinding(realm.registry, "cust-A1", a.space.uid);
    setBinding(realm.registry, "cust-B1", b.space.uid);

    await a.inject({ method: "PUT", url: "/api/router/bindings", payload: { bindings: [] } });

    const byCode = new Map(listBindings(realm.registry).map((x) => [x.externalUserId, x.uid]));
    expect(byCode.has("cust-A1")).toBe(false);
    expect(byCode.get("cust-B1")).toBe(b.space.uid); // 别人的不受影响
  });

  it("形状不合（不是数组 / 元素不是字符串 / 空串）→ 400，且不改任何绑定", async () => {
    const { realm, a } = await twoAccounts();
    setBinding(realm.registry, "keep-me", a.space.uid);

    for (const payload of [{ bindings: "x" }, { bindings: [1] }, { bindings: [""] }, {}]) {
      const res = await a.inject({ method: "PUT", url: "/api/router/bindings", payload });
      expect(res.statusCode).toBe(400);
    }
    expect(listBindings(realm.registry).map((x) => x.externalUserId)).toEqual(["keep-me"]);
  });

  it("未登录 → 401（账户侧路由在受保护作用域里）", async () => {
    const { a } = await twoAccounts();
    const res = await a.inject({
      method: "GET",
      url: "/api/router",
      headers: { cookie: "" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("Router 账户侧：分发开关", () => {
  it("关掉 → enabled=false，**绑定保留**（开关不等于解绑）", async () => {
    const { realm, a } = await twoAccounts();
    setBinding(realm.registry, "cust-A1", a.space.uid);

    const res = await a.inject({
      method: "PUT",
      url: "/api/router/enabled",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    const view = await a.inject({ method: "GET", url: "/api/router" });
    expect(view.json()).toEqual({ enabled: false, bindings: ["cust-A1"] });
  });

  it("开关是**按账户**的：关掉我，不影响别人", async () => {
    const { a, b } = await twoAccounts();
    await a.inject({ method: "PUT", url: "/api/router/enabled", payload: { enabled: false } });

    const viewB = await b.inject({ method: "GET", url: "/api/router" });
    expect(viewB.json()).toEqual({ enabled: true, bindings: [] });
  });

  it("请求体不合法 → 400", async () => {
    const { a } = await twoAccounts();
    const res = await a.inject({
      method: "PUT",
      url: "/api/router/enabled",
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});
