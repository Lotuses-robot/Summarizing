import { asc, eq } from "drizzle-orm";
import type { RegistryDb } from "./registry";
import { relaySettings } from "./registry";

// 部署级信源设置（D-130）：Router 的凭据、绑定表、拉取游标都走这里。
//
// 为什么是「部署级」而不是「账户级」：Router 是**一个**（不像信源每账户一个）——
// 微信凭据只有一份、绑定表要全局唯一、拉取游标只能有一个（两个进程各拉一次会互相踩）。
//
// 为什么是哑 KV：D-84 的原则——core 只存取、不解释内容。绑定表长什么样、凭据怎么用，
// 是 Router 自己的知识；storage 层只负责「把这个字符串存进去/取出来」。

/** 读一条部署级设置；未设置返回 null（与「存了空串」区分）。 */
export function getRelaySetting(db: RegistryDb, key: string): string | null {
  const row = db
    .select({ value: relaySettings.value })
    .from(relaySettings)
    .where(eq(relaySettings.key, key))
    .get();
  return row?.value ?? null;
}

/** 写一条部署级设置（UPSERT）。 */
export function setRelaySetting(db: RegistryDb, key: string, value: string): void {
  db.insert(relaySettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: relaySettings.key, set: { value } })
    .run();
}

/** 删一条部署级设置（不存在时静默成功——删除本就该幂等）。 */
export function deleteRelaySetting(db: RegistryDb, key: string): void {
  db.delete(relaySettings).where(eq(relaySettings.key, key)).run();
}

/** 全部键名（按字典序；运维命令列出用）。
 *
 *  只列键、不列值——凭据（secret / aesKey）就在这些键里，
 *  列表接口一不小心就会把它们打进终端历史或日志。取值的口子是 `getRelaySetting`，
 *  由调用方自己决定打不打码。 */
export function listRelaySettingKeys(db: RegistryDb): string[] {
  return db
    .select({ key: relaySettings.key })
    .from(relaySettings)
    .orderBy(asc(relaySettings.key))
    .all()
    .map((r) => r.key);
}
