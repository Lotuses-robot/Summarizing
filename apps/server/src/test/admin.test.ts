import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAdmin, type AdminIo } from "../cli/admin";
import { getAccountByUsername, makeRegistryDb } from "../storage/registry";
import { verifyPassword } from "../auth/password";

// 运维命令内核（006 / contracts/cli.md）：建号 / 发码 / 列表 / 停用启用 / 重置——
// 直调内核 + 临时 dataRoot + 脚本化 IO（**绝不碰仓库真 data/**）。

/** 脚本化 IO：按队列回答提问，收集输出行。 */
function scriptedIo(answers: string[] = []): AdminIo & { logs: string[] } {
  const queue = [...answers];
  const logs: string[] = [];
  return {
    logs,
    prompt: async () => {
      const a = queue.shift();
      if (a === undefined) throw new Error("测试回答队列已空");
      return a;
    },
    log: (line) => {
      logs.push(line);
    },
  };
}

const dirs: string[] = [];

/** 临时 dataRoot（afterEach 统一清）。 */
function tmpDataRoot(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "summarizing-admin-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("运维命令内核（contracts/cli.md）", () => {
  it("user:add：建账户（两次密码核对 + 哈希可验）；user:list 列 username/uid", async () => {
    const root = tmpDataRoot();
    const io = scriptedIo(["pw12345678", "pw12345678"]);
    await runAdmin(["user:add", "alice"], { dataRoot: root, io });
    expect(io.logs.join("\n")).toContain("账户 alice 已创建");

    const registry = makeRegistryDb(path.join(root, "system.db"));
    const acc = getAccountByUsername(registry, "alice");
    if (!acc) throw new Error("账户未建");
    expect(await verifyPassword("pw12345678", acc.passwordHash)).toBe(true);
    registry.$client.close();

    const io2 = scriptedIo();
    await runAdmin(["user:list"], { dataRoot: root, io: io2 });
    const out = io2.logs.join("\n");
    expect(out).toContain("alice");
    expect(out).toContain(acc.uid);
  });

  it("user:add 无参走交互用户名；密码不一致 / 过短 / 用户名被占 → 人话失败", async () => {
    const root = tmpDataRoot();
    // 无参：交互读用户名
    await runAdmin(["user:add"], {
      dataRoot: root,
      io: scriptedIo(["eve", "pw12345678", "pw12345678"]),
    });
    await expect(
      runAdmin(["user:add", "bob"], {
        dataRoot: root,
        io: scriptedIo(["pw12345678", "different"]),
      }),
    ).rejects.toThrow("两次输入不一致");
    await expect(
      runAdmin(["user:add", "bob"], { dataRoot: root, io: scriptedIo(["short"]) }),
    ).rejects.toThrow("密码至少 8 个字符");
    await runAdmin(["user:add", "bob"], {
      dataRoot: root,
      io: scriptedIo(["pw12345678", "pw12345678"]),
    });
    await expect(
      runAdmin(["user:add", "bob"], {
        dataRoot: root,
        io: scriptedIo(["pw12345678", "pw12345678"]),
      }),
    ).rejects.toThrow("已被占用");
  });

  it("停用/启用：状态落库（下一请求即生效的存储面）；不存在账户人话失败", async () => {
    const root = tmpDataRoot();
    await runAdmin(["user:add", "carol"], {
      dataRoot: root,
      io: scriptedIo(["pw12345678", "pw12345678"]),
    });
    await runAdmin(["user:disable", "carol"], { dataRoot: root, io: scriptedIo() });
    const registry = makeRegistryDb(path.join(root, "system.db"));
    expect(getAccountByUsername(registry, "carol")?.status).toBe("disabled");
    registry.$client.close();

    await runAdmin(["user:enable", "carol"], { dataRoot: root, io: scriptedIo() });
    const registry2 = makeRegistryDb(path.join(root, "system.db"));
    expect(getAccountByUsername(registry2, "carol")?.status).toBe("active");
    registry2.$client.close();

    await expect(
      runAdmin(["user:disable", "nobody"], { dataRoot: root, io: scriptedIo() }),
    ).rejects.toThrow("账户不存在");
  });

  it("passwd:reset：新密码可验、旧密码作废、tokenVersion+1（全端下线）", async () => {
    const root = tmpDataRoot();
    await runAdmin(["user:add", "dave"], {
      dataRoot: root,
      io: scriptedIo(["oldpw12345", "oldpw12345"]),
    });
    await runAdmin(["passwd:reset", "dave"], {
      dataRoot: root,
      io: scriptedIo(["newpw12345", "newpw12345"]),
    });
    const registry = makeRegistryDb(path.join(root, "system.db"));
    const acc = getAccountByUsername(registry, "dave");
    if (!acc) throw new Error("账户丢失");
    expect(acc.tokenVersion).toBe(2);
    expect(await verifyPassword("newpw12345", acc.passwordHash)).toBe(true);
    expect(await verifyPassword("oldpw12345", acc.passwordHash)).toBe(false);
    registry.$client.close();
  });

  it("invite:new：生成一次性码（有 baseUrl 附链接）；revoke 作废；重复作废失败", async () => {
    const root = tmpDataRoot();
    const io = scriptedIo();
    await runAdmin(["invite:new", "--days", "3"], {
      dataRoot: root,
      io,
      baseUrl: "https://sum.example.cn",
    });
    const out = io.logs.join("\n");
    const m = /邀请码：([0-9A-Z]{10})/.exec(out);
    if (!m) throw new Error("未见邀请码输出");
    const code = m[1] ?? "";
    expect(out).toContain(`https://sum.example.cn/register?code=${code}`);

    await runAdmin(["invite:revoke", code], { dataRoot: root, io: scriptedIo() });
    await expect(
      runAdmin(["invite:revoke", code], { dataRoot: root, io: scriptedIo() }),
    ).rejects.toThrow("作废失败");
  });

  it("未知命令：打用法并失败", async () => {
    const root = tmpDataRoot();
    const io = scriptedIo();
    await expect(runAdmin(["no:such"], { dataRoot: root, io })).rejects.toThrow("未知命令");
    expect(io.logs.join("\n")).toContain("user:add");
  });
});
