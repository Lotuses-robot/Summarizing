import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { nowLocalWallClock, wallClockFromDate } from "../shared/time";

// 系统库（data/system.db，D-96 / 00 契约 §十二）：账户登记——账户/邀请码/键值。
// 独立于用户库（data/users/<uid>.db）：服务器每请求读它做鉴权（CLI 也直接开它，WAL 跨进程安全）。
// ⚠️ 它是账户索引——丢失则全部用户库不可寻址；备份口径 = 整个 data/。

// ── 表结构（与 00 契约 §十二 一一对应；DDL 在 ensureRegistrySchema，COLLATE 等以 DDL 为准）──

/** 账户：uid 随机不可推导（库名来源）；username NOCASE 唯一；密码 scrypt 自描述哈希。 */
const accounts = sqliteTable("accounts", {
  uid: text("uid").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("active"), // active | disabled（停用为终态，L25）
  tokenVersion: integer("token_version").notNull().default(1), // 改密/重置 +1 → 旧会话全废
  sourceToken: text("source_token").notNull().unique(), // webhook 凭据（明文存，可轮换）
  createdAt: text("created_at").notNull(),
});

/** 邀请码：一次性（used_by 置位即废）+ 有效期（字符串序=时间序，直接比较）。 */
export const invites = sqliteTable(
  "invites",
  {
    code: text("code").primaryKey(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedBy: text("used_by"),
    usedAt: text("used_at"),
  },
  (t) => [index("invites_used_idx").on(t.usedBy)],
);

/** 系统键值：session_secret（会话签名密钥，首建生成）/ schema_version（版本号机制属批次 2）。 */
const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type AccountRow = typeof accounts.$inferSelect;

/** 打开系统库：幂等建表 + session_secret 缺失即生成（重启后会话不失效）；文件库开 WAL。 */
export function makeRegistryDb(file: string) {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  if (file !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }
  ensureRegistrySchema(sqlite);
  return drizzle(sqlite, { schema: { accounts, invites, meta } });
}

export type RegistryDb = ReturnType<typeof makeRegistryDb>;

/** 幂等建表（IF NOT EXISTS）+ 首建播种（session_secret / schema_version）。 */
function ensureRegistrySchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      uid TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      token_version INTEGER NOT NULL DEFAULT 1,
      source_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_by TEXT,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS invites_used_idx ON invites (used_by);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 会话密钥：INSERT OR IGNORE——存在即不动（换值 = 全员下线，是运维手段不是启动动作）
  sqlite
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('session_secret', ?)")
    .run(randomBytes(32).toString("hex"));
  sqlite.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
}

// ── 账户 ──

/** 新账户标识：uid 8B 随机 hex（库名），source_token 16B 随机 hex（webhook 凭据）。 */
function newUid(): string {
  return randomBytes(8).toString("hex");
}

/** 生成一把新接入令牌（建号与轮换共用同一出处）。 */
function newSourceToken(): string {
  return randomBytes(16).toString("hex");
}

/** 按用户名查账户（列级 COLLATE NOCASE——大小写不敏感）。 */
export function getAccountByUsername(db: RegistryDb, username: string): AccountRow | undefined {
  return db.select().from(accounts).where(eq(accounts.username, username)).get();
}

/** 按 uid 查账户。 */
export function getAccountByUid(db: RegistryDb, uid: string): AccountRow | undefined {
  return db.select().from(accounts).where(eq(accounts.uid, uid)).get();
}

/** 按接入令牌查账户（webhook 网关定向用）。 */
export function getAccountByToken(db: RegistryDb, token: string): AccountRow | undefined {
  return db.select().from(accounts).where(eq(accounts.sourceToken, token)).get();
}

/** 全量账户（CLI user:list 用；hub.ensureAll 自己过滤 active）。按创建时刻升序。 */
export function listAccounts(db: RegistryDb): AccountRow[] {
  return db.select().from(accounts).orderBy(accounts.createdAt).all();
}

/** 建一个账户（uid 与令牌在此生成）；重名由 UNIQUE 约束响亮拒绝（调用方转 409）。 */
export function createAccount(
  db: RegistryDb,
  args: { username: string; passwordHash: string },
): AccountRow {
  const row: AccountRow = {
    uid: newUid(),
    username: args.username,
    passwordHash: args.passwordHash,
    status: "active",
    tokenVersion: 1,
    sourceToken: newSourceToken(),
    createdAt: nowLocalWallClock(),
  };
  db.insert(accounts).values(row).run();
  return row;
}

/** 停用/启用（CLI 命令用；停用立即于下一请求生效——鉴权每请求读本表）。 */
export function setAccountStatus(db: RegistryDb, uid: string, status: "active" | "disabled"): void {
  db.update(accounts).set({ status }).where(eq(accounts.uid, uid)).run();
}

/** 改密/重置：换哈希 + token_version+1（同一语句原子）——旧会话全下线。 */
export function setPasswordHashAndBumpTokenVersion(
  db: RegistryDb,
  uid: string,
  passwordHash: string,
): void {
  db.update(accounts)
    .set({ passwordHash, tokenVersion: sql`${accounts.tokenVersion} + 1` })
    .where(eq(accounts.uid, uid))
    .run();
}

/** 轮换热源接入令牌：生成新值落库并返回（旧值即刻作废——按 token 查询即失效）。 */
export function rotateSourceToken(db: RegistryDb, uid: string): string {
  const token = newSourceToken();
  db.update(accounts).set({ sourceToken: token }).where(eq(accounts.uid, uid)).run();
  return token;
}

// ── 邀请码 ──

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 无歧义字母表（去 I/L/O/U）

/** 生成 10 位无歧义邀请码（32 整除 256，取模无偏）。 */
function newInviteCode(): string {
  return Array.from(randomBytes(10), (b) => CROCKFORD[b % 32]).join("");
}

/** 发一张一次性邀请码（默认 7 天有效）；返回码与到期时刻（墙钟串）。 */
export function createInvite(db: RegistryDb, days = 7): { code: string; expiresAt: string } {
  const code = newInviteCode();
  const expiresAt = wallClockFromDate(new Date(Date.now() + days * 86_400_000));
  db.insert(invites)
    .values({ code, createdAt: nowLocalWallClock(), expiresAt, usedBy: null, usedAt: null })
    .run();
  return { code, expiresAt };
}

/** 作废未使用的邀请码（已用/不存在返回 false——幂等可见）。 */
export function revokeInvite(db: RegistryDb, code: string): boolean {
  const res = db
    .delete(invites)
    .where(and(eq(invites.code, code), isNull(invites.usedBy)))
    .run();
  return res.changes === 1;
}

/** 注册事务：核销邀请码 + 建账户，**原子**——码不可用或用户名被占整批回滚，绝不烧码。
 *  返回 reason 供路由映射状态码（code→400 话术统一 / username→409）。 */
export function redeemInviteAndCreateAccount(
  db: RegistryDb,
  args: { code: string; username: string; passwordHash: string },
): { ok: true; account: AccountRow } | { ok: false; reason: "code" | "username" } {
  const now = nowLocalWallClock();
  try {
    return db.transaction((tx) => {
      // 原子核销：未用 + 未过期（字符串序=时间序，直接比较）——变更行数判定，并发双注册恰一成功
      const redeemed = tx
        .update(invites)
        .set({ usedBy: "__pending__", usedAt: now })
        .where(and(eq(invites.code, args.code), isNull(invites.usedBy), gt(invites.expiresAt, now)))
        .run();
      if (redeemed.changes !== 1) {
        return { ok: false as const, reason: "code" as const };
      }
      const account = createAccountInTx(tx, args);
      tx.update(invites).set({ usedBy: account.uid }).where(eq(invites.code, args.code)).run();
      return { ok: true as const, account };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "username" };
    throw err;
  }
}

/** 事务内建账户（与 createAccount 同形；tx 无 .transaction 但读写 API 相同）。 */
function createAccountInTx(
  tx: Parameters<Parameters<RegistryDb["transaction"]>[0]>[0],
  args: { username: string; passwordHash: string },
): AccountRow {
  const row: AccountRow = {
    uid: newUid(),
    username: args.username,
    passwordHash: args.passwordHash,
    status: "active",
    tokenVersion: 1,
    sourceToken: newSourceToken(),
    createdAt: nowLocalWallClock(),
  };
  tx.insert(accounts).values(row).run();
  return row;
}

/** better-sqlite3 的唯一约束冲突判定（不 import 其错误类型——按 code 字符串兜住；`in` 窄化免断言）。 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return err.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** 注册补偿（006 评审修复）：空间装配失败时撤回已提交的注册——删账户行 + 邀请码退回未用
 *  （同一事务；补偿自身失败由调用方记日志，如实 500——绝不把一次性码静默吞掉）。 */
export function rollbackRegistration(db: RegistryDb, uid: string, code: string): void {
  db.transaction((tx) => {
    tx.delete(accounts).where(eq(accounts.uid, uid)).run();
    tx.update(invites)
      .set({ usedBy: null, usedAt: null })
      .where(and(eq(invites.code, code), eq(invites.usedBy, uid)))
      .run();
  });
}

// ── meta ──

/** 读 meta 键；不存在返回 null（getSessionSecret 的内部读口）。 */
function getMeta(db: RegistryDb, key: string): string | null {
  const row = db.select().from(meta).where(eq(meta.key, key)).get();
  return row?.value ?? null;
}

/** 读会话签名密钥（首建已播种；此处只读不生成）。 */
export function getSessionSecret(db: RegistryDb): string {
  const value = getMeta(db, "session_secret");
  if (value === null) throw new Error("系统库缺少 session_secret（库被损坏？）");
  return value;
}
