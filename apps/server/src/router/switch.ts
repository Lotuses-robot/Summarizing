import { z } from "zod";
import { getRelaySetting, setRelaySetting } from "../storage/relay-kv";
import type { RegistryDb } from "../storage/registry";

// 分发开关（D-130）：账户主人说「先别把消息往我这儿送」。
//
// 为什么它**不是**「清掉绑定」：两者对客户说的话不一样——
//   · 开关关着 → 回「接收方暂不可用」（客户知道人还在，只是暂时收不了）
//   · 没绑定   → 回一串绑定码（客户要去把它交给账户主人）
// 把开关做成「删绑定」会让一个只是暂时停用的人，害客户收到一串莫名其妙的码。
//
// 为什么存部署级：Router 在投递前就要判断，而它**不碰任何账户库**（D-130 分工）。
// 一个 uid 开关一位，全部署共一张表。

/** 关掉的账户（存成一个 JSON 数组；账户数量级是「几个」）。 */
const DISABLED_KEY = "delivery.disabled";

/** 形状：uid 数组。坏数据抛（与绑定表同一条理由——读错会把该拦的放过去）。 */
const DisabledSchema = z.array(z.string());

/** 读被关掉的账户集合。**坏数据直接抛**（静默当成空集 = 把所有关掉的开关偷偷打开）。 */
function readDisabled(db: RegistryDb): Set<string> {
  const raw = getRelaySetting(db, DISABLED_KEY);
  if (raw === null) return new Set(); // 从未关过 = 空集（正常初始态）
  const json: unknown = JSON.parse(raw); // 坏 JSON → 抛
  return new Set(DisabledSchema.parse(json)); // 形状不对 → 抛
}

/** 某账户当前是否接收分发（默认开——未设置 = 开，新账户无需先点开关）。 */
export function isDeliveryEnabled(db: RegistryDb, uid: string): boolean {
  return !readDisabled(db).has(uid);
}

/** 打开/关闭某账户的分发（幂等；重复设同一值不写库）。 */
export function setDeliveryEnabled(db: RegistryDb, uid: string, enabled: boolean): void {
  if (uid === "") return; // 空 uid 无意义（不写）
  const disabled = readDisabled(db);
  const changed = enabled ? disabled.delete(uid) : disabled.add(uid);
  if (!changed) return;
  setRelaySetting(db, DISABLED_KEY, JSON.stringify([...disabled].sort()));
}
