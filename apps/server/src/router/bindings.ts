import { z } from "zod";
import { getRelaySetting, setRelaySetting } from "../storage/relay-kv";
import type { RegistryDb } from "../storage/registry";

// 绑定表（D-130）：external_userid → uid。
//
// 为什么存部署级：Router 是**一个**——绑定关系全局唯一，不能每个账户各存一份
// （否则同一个客户在不同账户的库里会有不同的归属，说不清该信谁）。
//
// 为什么绑定码就是 external_userid 原文（不哈希）：本轮用户明确要降低复杂度
// （「目前就直接微信 uuid 匹配吧，这次内容已经太多了」）。代价是用户要能拿到这个 id
// ——它由 Router 回给客户，客户自己复制给账户主人。哈希版本留待以后（见 docs/03）。
//
// 为什么不做校验：用户定「就是个配置而已，不做校验」。填错了自然收不到消息，
// 用户自己会发现——这比在保存时拦一道、还得解释「为什么这个 id 不存在」更省事。
//
// 为什么坏数据抛错而不兜底：绑定表是「归属」的唯一依据。兜底成空表 = 把所有客户判成
// 未绑定、给他们全发一遍绑定码，消息静默丢失。响亮失败让人去修库，比静默发错码安全。

/** 绑定表的存储键（整张表存成一个 JSON 串——客户数量级是「几个」，不需要一行一个）。 */
const BINDINGS_KEY = "bindings";

/** 绑定表的形状：external_userid → uid。
 *
 *  为什么用一个对象而不是 `Map`：它要序列化成 JSON 存进 KV。读回来时过 zod 校验形状
 *  ——不符合就抛（见 `readAll` 的理由）。 */
const BindingsSchema = z.record(z.string(), z.string());

/** 读整张绑定表。
 *
 *  **坏数据直接抛**（不兜底成空表）：绑定表是「谁的消息归谁」的唯一依据——
 *  把它当成空表继续跑，等于把**所有客户**判成未绑定、给他们全部发一遍绑定码，
 *  而那些消息会静默丢失。响亮失败让运维看见并修库，比静默发错码好得多。
 *
 *  @throws JSON 解析失败，或解析出的形状不是 `{ [externalUserId]: uid }`
 */
function readAll(db: RegistryDb): Record<string, string> {
  const raw = getRelaySetting(db, BINDINGS_KEY);
  if (raw === null) return {}; // 从未绑定过 = 空表（这是正常初始态，不是坏数据）
  const json: unknown = JSON.parse(raw); // 坏 JSON → 抛（SyntaxError）
  return BindingsSchema.parse(json); // 形状不对 → 抛（ZodError，带路径）
}

/** 查一个 external_userid 绑到哪个账户；未绑定返回 null。 */
export function resolveBinding(db: RegistryDb, externalUserId: string): string | null {
  if (externalUserId === "") return null; // 空串不是合法客户 id（不写、不查）
  return readAll(db)[externalUserId] ?? null;
}

/** 建立/覆盖一条绑定。同一 id 重复绑会覆盖（后写为准），并留痕——不静默改归属。
 *
 *  @param db 系统库
 *  @param externalUserId 客户的微信 id
 *  @param uid 目标账户
 */
export function setBinding(db: RegistryDb, externalUserId: string, uid: string): void {
  if (externalUserId === "" || uid === "") return; // 两样都不可为空（空绑定无意义）
  const all = readAll(db);
  const previous = all[externalUserId];
  if (previous !== undefined && previous !== uid) {
    process.stderr.write(`[router] 绑定覆盖：${externalUserId} 从 ${previous} 改绑到 ${uid}\n`);
  }
  all[externalUserId] = uid;
  setRelaySetting(db, BINDINGS_KEY, JSON.stringify(all));
}

/** 解除一条绑定；不存在时幂等成功。 */
export function removeBinding(db: RegistryDb, externalUserId: string): void {
  const all = readAll(db);
  if (all[externalUserId] === undefined) return;
  delete all[externalUserId];
  setRelaySetting(db, BINDINGS_KEY, JSON.stringify(all));
}

/** 列出全部绑定（运维命令用；客户数量级小，直接全量返回）。 */
export function listBindings(db: RegistryDb): Array<{ externalUserId: string; uid: string }> {
  return Object.entries(readAll(db)).map(([externalUserId, uid]) => ({ externalUserId, uid }));
}
