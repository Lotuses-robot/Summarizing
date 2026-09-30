import type { SourceAdapter } from "./types";
import { makeNcAdapter } from "./nc";

// 信源适配器注册表（D-84）：一个源一行——信源 = 代码内自包含模块，
// 非运行时动态加载（纪律 #4 排除的是后者）。新源落地步骤见 docs/07-接新源检查单.md。

/** 生产注册表（按注册序上岗）。 */
const ADAPTERS: SourceAdapter[] = [makeNcAdapter()];

/** 注册表只读出口（index.ts 装配用；测试直接给 makeApp 注入替身适配器）。 */
export function allSourceAdapters(): SourceAdapter[] {
  return ADAPTERS;
}
