import type { SourceAdapter } from "./types";
import { makeNcAdapter } from "./nc";

// 信源适配器注册表（D-84）：一个源一行——信源 = 代码内自包含模块，
// 非运行时动态加载（纪律 #4 排除的是后者）。新源落地步骤见 docs/07-接新源检查单.md。

/** 生产注册表（按注册序上岗）：**工厂**——每空间（账户）各造一份实例（私有态天然隔离，D-96）。
 *
 *  ⚠️ **微信客服暂未注册**（2026-10-23 起停用）：企业微信以《用户账号使用规范》限制账号，
 *  申诉期间把 Router 与信源两侧一并停用。代码与测试都保留，恢复时把 `makeWecomAdapter`
 *  加回本数组、并在 `router/index.ts` 的 `INGRESS_FACTORIES` 加回 wecom 接入即可——
 *  **但恢复前必须先改掉当时踩线的两处行为**（见 router/index.ts 的注释）。 */
const ADAPTER_FACTORIES: Array<() => SourceAdapter> = [makeNcAdapter];

/** 注册表只读出口（空间装配用；测试直接给装配注入替身适配器）。 */
export function allSourceAdapters(): Array<() => SourceAdapter> {
  return ADAPTER_FACTORIES;
}
