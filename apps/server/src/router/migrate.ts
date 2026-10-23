import { getRelaySetting, setRelaySetting } from "../storage/relay-kv";
import type { RegistryDb } from "../storage/registry";

// 旧键迁移（D-134）：v0.7.0 的绑定表与开关是**不分接入**的全局键，v0.7.1 起按接入分区。
//
// 只有 `wecom` 一个接入用过旧键，所以旧数据整体归到 `wecom` 名下——不需要猜「这条属于谁」，
// 那个年代只有微信客服一种路由。
//
// 幂等：目标键已存在就跳过（重复开库无副作用）；旧键**保留不动**（不删——万一要回滚到
// v0.7.0，旧版本读得到自己那份数据；新版本从此只读写新键，两者不并存于读路径）。

/** 旧键 → 新键的对照（v0.7.0 的全局键归到 wecom 名下）。 */
const LEGACY_KEYS: Array<{ from: string; to: string }> = [
  { from: "bindings", to: "bindings:wecom" },
  { from: "delivery.disabled", to: "delivery.disabled:wecom" },
];

/** 把旧版全局键迁到按接入分区的新键。幂等；坏数据原样不动（读路径会响亮报错，不在这里吞）。
 *
 *  @param db 系统库
 *  @returns 实际迁移了几个键（0 = 无事可做）
 */
export function migrateLegacyRelayKeys(db: RegistryDb): number {
  let migrated = 0;
  for (const { from, to } of LEGACY_KEYS) {
    const legacy = getRelaySetting(db, from);
    if (legacy === null) continue; // 旧版没写过 = 没什么可迁
    if (getRelaySetting(db, to) !== null) continue; // 已迁过（或本来就有新键）= 不覆盖
    setRelaySetting(db, to, legacy);
    migrated += 1;
    process.stderr.write(`[router] 迁移旧键 ${from} → ${to}（v0.7.0 → v0.7.1）\n`);
  }
  return migrated;
}
