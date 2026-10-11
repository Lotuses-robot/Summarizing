import type { SourceAdapter } from "./types";
import { makeNcAdapter } from "./nc";

// 信源适配器注册表（D-84）：一个源一行——信源 = 代码内自包含模块，
// 非运行时动态加载（纪律 #4 排除的是后者）。新源落地步骤见 docs/07-接新源检查单.md。

/** 生产注册表（按注册序上岗）：**工厂**——每空间（账户）各造一份实例（私有态天然隔离，D-96）。 */
const ADAPTER_FACTORIES: Array<() => SourceAdapter> = [makeNcAdapter];

/** 注册表只读出口（空间装配用；测试直接给装配注入替身适配器）。 */
export function allSourceAdapters(): Array<() => SourceAdapter> {
  return ADAPTER_FACTORIES;
}
