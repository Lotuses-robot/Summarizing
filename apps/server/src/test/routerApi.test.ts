import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAllTestAccounts,
  makeTestRealm,
  type TestRealm,
  type TestAccount,
} from "./helpers/app";
import { makeBindingStore, makeDeliverySwitch } from "../router/store";
import type { RouterChannel } from "@summarizing/shared";

// 账户侧的 Router 入口（D-130 / D-134）：`GET /api/router`、`PUT /api/router/:kind/bindings`、
// `PUT /api/router/:kind/enabled`。
//
// 这一层的验收点有两个：①**隔离**——一个账户只能看见/改动自己的绑定（绑定表是部署级的，
// 「谁能改哪几行」必须由会话 uid 决定，不能由请求体说了算）；②**按接入分组**——每个接入
// 各有一份绑定表与开关，加一个新接入时这一页与这些路由都不用改。

afterEach(async () => {
  await cleanupAllTestAccounts();
});

/** 造一个带两个账户的实例（隔离用例需要同实例多账户）。
 *  装 Router（账户侧视图的接入清单来自它——`ingresses()`）。 */
async function twoAccounts(): Promise<{ realm: TestRealm; a: TestAccount; b: TestAccount }> {
  const realm = await makeTestRealm({ withRouter: true });
  const a = await realm.addAccount({ username: "alpha" });
  const b = await realm.addAccount({ username: "beta" });
  return { realm, a, b };
}

/** 取视图里的 channels 数组（响应体的形状由 shared 契约给定）。 */
function channelOfKind(body: unknown): Array<{ kind: string; label: string }> {
  return (body as { channels: Array<{ kind: string; label: string }> }).channels;
}

/** 取某个接入在视图里的那一段（测试只关心 wecom 这一组）。 */
function channelOf(body: unknown, kind: string): RouterChannel {
  const parsed = body as { channels: RouterChannel[] };
  const found = parsed.channels.find((c) => c.kind === kind);
  if (found === undefined) throw new Error(`视图里没有 ${kind} 这一组`);
  return found;
}

describe("Router 账户侧：按接入分组", () => {
  it("视图是 channels 数组，每组自带 label / description / enabled / bindings", async () => {
    const { a } = await twoAccounts();
    const res = await a.inject({ method: "GET", url: "/api/router" });
    expect(res.statusCode).toBe(200);

    const wecom = channelOf(res.json(), "wecom");
    expect(wecom.label).toBe("微信客服"); // 由接入自己声明
    expect(wecom.description).not.toBe("");
    expect(wecom.enabled).toBe(true); // 新账户默认接收
    expect(wecom.bindings).toEqual([]);
  });

  it("未知接入 → 404（不猜一个默认接入）", async () => {
    const { a } = await twoAccounts();
    const res = await a.inject({
      method: "PUT",
      url: "/api/router/nosuch/bindings",
      payload: { bindings: ["x"] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Router 账户侧：加一个新接入（D-134 的判据——只该动接入自己的目录）", () => {
  it("注入第二个接入 → 视图自动多一组，账户侧路由一行没改就能读写它", async () => {
    // 这条是这次重构的验收核心：加「校内新闻」这种广播源，**不该**改
    // routes/router.ts、前端、shared 契约——它们都按接入自己声明的元数据渲染。
    /** 一个假「校内新闻」接入：只声明元数据 + 自己的存储，不挂任何 HTTP。 */
    const fakeNews = ({ db }: { db: Parameters<typeof makeBindingStore>[0] }) => {
      const { bindings, delivery } = {
        bindings: makeBindingStore(db, "njunews"),
        delivery: makeDeliverySwitch(db, "njunews"),
      };
      return {
        name: "njunews",
        label: "校内新闻",
        description: "学校官网的公告",
        bindings,
        delivery,
        register: () => undefined,
      };
    };
    const realm = await makeTestRealm({ withRouter: true, ingressFactories: [fakeNews] });
    const a = await realm.addAccount({ username: "alpha" });

    // ① 视图里两组并存，各自的标题来自各自的声明
    const view = await a.inject({ method: "GET", url: "/api/router" });
    const kinds = channelOfKind(view.json());
    expect(kinds.map((c) => c.kind)).toEqual(["njunews"]);
    expect(kinds[0]?.label).toBe("校内新闻");

    // ② 写它的绑定码：走同一个路由，只是 kind 不同
    const put = await a.inject({
      method: "PUT",
      url: "/api/router/njunews/bindings",
      payload: { bindings: ["计算机学院"] },
    });
    expect(put.statusCode).toBe(200);
    expect(makeBindingStore(realm.registry, "njunews").listFor(a.space.uid)).toEqual([
      "计算机学院",
    ]);

    // ③ 两种接入的数据**互不串**：njunews 的码不会出现在 wecom 表里
    expect(makeBindingStore(realm.registry, "wecom").listAll()).toEqual([]);
  });

  it("关掉一个接入不影响另一个（开关按接入分区）", async () => {
    const realm = await makeTestRealm({ withRouter: true, ingressFactories: [] });
    const a = await realm.addAccount({ username: "alpha" });

    const wecomSwitch = makeDeliverySwitch(realm.registry, "wecom");
    const newsSwitch = makeDeliverySwitch(realm.registry, "njunews");
    wecomSwitch.set(a.space.uid, false);
    expect(wecomSwitch.isEnabled(a.space.uid)).toBe(false);
    expect(newsSwitch.isEnabled(a.space.uid)).toBe(true); // 没被连带关掉
  });
});

describe("Router 账户侧：读视图", () => {
  it("只列**我**的绑定码（别人的看不到）", async () => {
    const { realm, a, b } = await twoAccounts();
    const store = makeBindingStore(realm.registry, "wecom");
    store.set("cust-A1", a.space.uid);
    store.set("cust-B1", b.space.uid);

    const res = await a.inject({ method: "GET", url: "/api/router" });
    expect(channelOf(res.json(), "wecom").bindings).toEqual(["cust-A1"]);
  });

  it("一个账户可以有多个绑定码（一个人多个微信），按字典序列出", async () => {
    const { realm, a } = await twoAccounts();
    const store = makeBindingStore(realm.registry, "wecom");
    store.set("cust-Z", a.space.uid);
    store.set("cust-A", a.space.uid);

    const res = await a.inject({ method: "GET", url: "/api/router" });
    expect(channelOf(res.json(), "wecom").bindings).toEqual(["cust-A", "cust-Z"]);
  });
});

describe("Router 账户侧：写绑定码", () => {
  it("整段覆盖：新码绑到我，删掉的码解绑", async () => {
    const { realm, a } = await twoAccounts();
    const store = makeBindingStore(realm.registry, "wecom");
    store.set("old-code", a.space.uid);

    const res = await a.inject({
      method: "PUT",
      url: "/api/router/wecom/bindings",
      payload: { bindings: ["new-code"] },
    });
    expect(res.statusCode).toBe(200);

    const view = await a.inject({ method: "GET", url: "/api/router" });
    expect(channelOf(view.json(), "wecom").bindings).toEqual(["new-code"]);
    // 「old-code」已整个解绑
    expect(store.listAll().map((x) => x.code)).not.toContain("old-code");
  });

  it("只能改自己那份：提交别人的码会把它**改绑**过来（后写为准），但不会动自己原有的码", async () => {
    const { realm, a, b } = await twoAccounts();
    const store = makeBindingStore(realm.registry, "wecom");
    store.set("cust-B1", b.space.uid);
    store.set("cust-A1", a.space.uid);

    await a.inject({
      method: "PUT",
      url: "/api/router/wecom/bindings",
      payload: { bindings: ["cust-A1", "cust-B1"] },
    });

    const byCode = new Map(store.listAll().map((x) => [x.code, x.uid]));
    expect(byCode.get("cust-A1")).toBe(a.space.uid);
    expect(byCode.get("cust-B1")).toBe(a.space.uid); // 改绑过来了
  });

  it("提交空数组 → 我名下全解绑（别人的不动）", async () => {
    const { realm, a, b } = await twoAccounts();
    const store = makeBindingStore(realm.registry, "wecom");
    store.set("cust-A1", a.space.uid);
    store.set("cust-B1", b.space.uid);

    await a.inject({
      method: "PUT",
      url: "/api/router/wecom/bindings",
      payload: { bindings: [] },
    });

    const byCode = new Map(store.listAll().map((x) => [x.code, x.uid]));
    expect(byCode.has("cust-A1")).toBe(false);
    expect(byCode.get("cust-B1")).toBe(b.space.uid); // 别人的不受影响
  });

  it("形状不合（不是数组 / 元素不是字符串 / 空串）→ 400，且不改任何绑定", async () => {
    const { realm, a } = await twoAccounts();
    const store = makeBindingStore(realm.registry, "wecom");
    store.set("keep-me", a.space.uid);

    for (const payload of [{ bindings: "x" }, { bindings: [1] }, { bindings: [""] }, {}]) {
      const res = await a.inject({
        method: "PUT",
        url: "/api/router/wecom/bindings",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(store.listAll().map((x) => x.code)).toEqual(["keep-me"]);
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
    makeBindingStore(realm.registry, "wecom").set("cust-A1", a.space.uid);

    const res = await a.inject({
      method: "PUT",
      url: "/api/router/wecom/enabled",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    const view = await a.inject({ method: "GET", url: "/api/router" });
    const wecom = channelOf(view.json(), "wecom");
    expect(wecom.enabled).toBe(false);
    expect(wecom.bindings).toEqual(["cust-A1"]);
  });

  it("开关是**按账户**的：关掉我，不影响别人", async () => {
    const { a, b } = await twoAccounts();
    await a.inject({
      method: "PUT",
      url: "/api/router/wecom/enabled",
      payload: { enabled: false },
    });

    const viewB = await b.inject({ method: "GET", url: "/api/router" });
    expect(channelOf(viewB.json(), "wecom").enabled).toBe(true);
  });

  it("请求体不合法 → 400", async () => {
    const { a } = await twoAccounts();
    const res = await a.inject({
      method: "PUT",
      url: "/api/router/wecom/enabled",
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});
