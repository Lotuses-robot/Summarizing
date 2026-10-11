import path from "node:path";
import { mkdirSync } from "node:fs";
import { InviteCodeSchema, PasswordSchema, UsernameSchema } from "@summarizing/shared";
import {
  createAccount,
  createInvite,
  getAccountByUsername,
  listAccounts,
  makeRegistryDb,
  revokeInvite,
  setAccountStatus,
  setPasswordHashAndBumpTokenVersion,
  type RegistryDb,
} from "../storage/registry";
import { hashPassword } from "../auth/password";

// 运维命令**内核**（006 / contracts/cli.md）：建号 / 发码 / 列表 / 停用启用 / 重置密码——
// 唯一管理通道的行为层。入口壳在 scripts/admin.ts（dev tsx）与 apps/server/dist/admin.mjs（发布包）。
// 本模块可被测试直调：dataRoot 与 IO 全部注入——**测试绝不碰仓库真 data/**。

/** 交互接口（默认实现读进程 stdin；测试注入脚本化回答）。 */
export interface AdminIo {
  /** 读一行（secret=true 时由实现方决定隐藏回显；本内核只关心拿到值）。 */
  prompt(question: string, opts: { secret: boolean }): Promise<string>;
  /** 输出一行（stdout 或测试收集器）。 */
  log(line: string): void;
}

export interface AdminDeps {
  /** 数据目录（内含 system.db）——调用方定位（仓库根/发布包根）。 */
  dataRoot: string;
  io: AdminIo;
  /** BASE_URL（invite:new 附注册链接用；缺省不附）。 */
  baseUrl?: string;
}

/** 用法文本（未知命令分支打它）。 */
const ADMIN_USAGE = `用法（运维命令）：
  user:add <username>        创建账户（交互输入密码；首个账户即由它诞生；用户名可省略走交互）
  user:list                  列出全部账户（username / status / createdAt / uid）
  user:disable <username>    停用（下一请求即生效：登录拒 / 会话断 / webhook 令牌失效）
  user:enable <username>     启用
  passwd:reset <username>    重置密码（全端下线；交互输入新密码）
  invite:new [--days N]      生成一次性邀请码（默认 7 天；设 BASE_URL 时附完整注册链接）
  invite:revoke <code>       作废未使用的邀请码`;

/** 按用户名取账户；不存在/格式坏抛人话错误。 */
function mustFind(db: RegistryDb, usernameRaw: string) {
  const parsed = UsernameSchema.safeParse(usernameRaw);
  if (!parsed.success) throw new Error("用户名格式不正确");
  const account = getAccountByUsername(db, parsed.data);
  if (account === undefined) throw new Error(`账户不存在：${parsed.data}`);
  return account;
}

/** 交互读两次密码并核对：规则与文案复用 **PasswordSchema**（shared 单一出处——曾手写 length<8，
 *  且线下建号可绕开 API 的 200 上限）；不合规/不一致**重问**，连续 3 轮失败才放弃。 */
async function askPasswordTwice(io: AdminIo): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await io.prompt("密码（≥8 字符，不回显）：", { secret: true });
    const parsed = PasswordSchema.safeParse(first);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      io.log(`${issue ? issue.message : "密码不合规"}，请重试`);
      continue;
    }
    const second = await io.prompt("再输一次：", { secret: true });
    if (first !== second) {
      io.log("两次输入不一致，请重试");
      continue;
    }
    return parsed.data;
  }
  throw new Error("密码输入连续 3 次失败，已取消");
}

/** 执行一条运维命令；失败抛人话错误（入口壳负责打印与退出码）。 */
export async function runAdmin(argv: string[], deps: AdminDeps): Promise<void> {
  mkdirSync(deps.dataRoot, { recursive: true });
  const db = makeRegistryDb(path.join(deps.dataRoot, "system.db"));
  const { io } = deps;
  const cmd = argv[0] ?? "";
  const arg = argv[1];
  const rest = argv.slice(2);
  try {
    switch (cmd) {
      case "user:add": {
        const usernameArg = arg ?? (await io.prompt("用户名：", { secret: false }));
        const parsed = UsernameSchema.safeParse(usernameArg);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw new Error(`用户名不合规：${first ? first.message : "格式不正确"}`);
        }
        if (getAccountByUsername(db, parsed.data) !== undefined) {
          throw new Error(`用户名已被占用：${parsed.data}`);
        }
        const password = await askPasswordTwice(io);
        const account = createAccount(db, {
          username: parsed.data,
          passwordHash: await hashPassword(password),
        });
        io.log(`账户 ${account.username} 已创建（uid=${account.uid}）`);
        return;
      }
      case "user:list": {
        const rows = listAccounts(db);
        if (rows.length === 0) {
          io.log("（暂无账户——先 user:add 建一个）");
          return;
        }
        io.log("username\tstatus\tcreatedAt\tuid");
        for (const r of rows) io.log(`${r.username}\t${r.status}\t${r.createdAt}\t${r.uid}`);
        return;
      }
      case "user:disable":
      case "user:enable": {
        if (arg === undefined) throw new Error(`用法：${cmd} <username>`);
        const account = mustFind(db, arg);
        const status = cmd === "user:disable" ? "disabled" : "active";
        setAccountStatus(db, account.uid, status);
        io.log(
          `账户 ${account.username} 已${status === "disabled" ? "停用" : "启用"}（下一请求即生效）`,
        );
        return;
      }
      case "passwd:reset": {
        if (arg === undefined) throw new Error("用法：passwd:reset <username>");
        const account = mustFind(db, arg);
        const password = await askPasswordTwice(io);
        setPasswordHashAndBumpTokenVersion(db, account.uid, await hashPassword(password));
        io.log(`账户 ${account.username} 密码已重置（该账户全部旧会话已下线）`);
        return;
      }
      case "count:accounts": {
        // start.cmd 首启判定用（内部件，不在用法清单）：输出可用账户数——0 才引导建号
        io.log(String(listAccounts(db).filter((a) => a.status === "active").length));
        return;
      }
      case "invite:new": {
        let days = 7;
        if (arg === "--days") {
          const n = Number(rest[0]);
          if (!Number.isInteger(n) || n <= 0 || n > 365) {
            throw new Error("--days 需为 1~365 的整数");
          }
          days = n;
        } else if (arg !== undefined) {
          throw new Error("用法：invite:new [--days N]");
        }
        const { code, expiresAt } = createInvite(db, days);
        io.log(`邀请码：${code}（${expiresAt} 前有效，一次性）`);
        if (deps.baseUrl !== undefined && deps.baseUrl !== "") {
          io.log(`注册链接：${deps.baseUrl.replace(/\/$/, "")}/register?code=${code}`);
        }
        return;
      }
      case "invite:revoke": {
        if (arg === undefined) throw new Error("用法：invite:revoke <code>");
        const parsed = InviteCodeSchema.safeParse(arg); // 归一规则住 schema（shared 单一出处）
        if (!parsed.success) throw new Error("邀请码格式不正确");
        if (!revokeInvite(db, parsed.data)) throw new Error("作废失败：码不存在或已被使用");
        io.log(`邀请码 ${parsed.data} 已作废`);
        return;
      }
      default:
        io.log(ADMIN_USAGE);
        throw new Error(cmd === "" ? "未给命令（见上方用法）" : `未知命令：${cmd}`);
    }
  } finally {
    // CLI 自己开的句柄自己关（进程退出兜底之外——测试直调时不做会锁住临时文件）
    db.$client.close();
  }
}
