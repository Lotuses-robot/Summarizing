import jieba from "nodejieba";
import type { Identity } from "@summarizing/shared";

// nodejieba 是 CJS 包且导出是运行时动态挂上去的（wrapWithDictLoad）——ESM 的具名导入解析不到
// cutForSearch（静态分析看不见）。走默认导入拿整个 module.exports（Node 的 CJS↔ESM 互操作）。

// 词典在**模块加载时**显式加载一次（约 750ms 读 11MB 词典），而不是等第一次切词才懒加载：
//  ① 懒加载发生在 makeDb 里（开库 → 索引回填 → 切词），而单测常在这之前 `vi.useFakeTimers()`——
//     假计时器把 Date.now/performance.now 冻住，nodejieba 内部耗时判定卡死，测试整片超时（实测）。
//  ② 加载是一次性固定成本：放进模块导入期，它发生在任何测试 setup 之前，且只发生一次。
// 加载失败会 FATAL 退进程（nodejieba 的 native 行为，不是可捕获异常）——所以词典文件必须随包分发；
// 三条产线的拷贝清单见 Dockerfile / scripts/build-release.mjs。
jieba.load();

// 切词单一出处（D-127）：内容切词 + 身份词袋 + 图片占位处理都在这里。
//
// 为何要切：SQLite FTS5 自带的 unicode61 分词器**不切中文**——连续中文被当成一个 token，
// 于是「英语课群」能整词命中，但「课群」（它的内部子串）搜不到。切词后每个词独立成 token，
// 部分匹配才成立。
//
// 为何要 jieba 词 + 二元组（bigram）两套：
//   jieba 词负责「像词一样」的匹配（「图书馆」命中「图书馆通知」）；
//   二元组负责 jieba 切碎的短词（「高数」被切成 高/数——二字词在 jieba 词典里常常缺失）。
//   实测 jieba 把「英语课群」切成 英语/英语课/群、「高数」切成 高/数、「班级通知群」切成
//   班级/通知/群——若只留 jieba 词且丢掉单字，「课群」「高数」就再也搜不到。
//
// 为何图片占位要整体替换：`[图片](url)` 的 URL 进了词袋，搜「rkey」「multimedia」会命中
// QQ 图链接——纯噪音。整体替换成「图片」既保住「这条批有图」这个事实，又不让 URL 污染索引。

/** 索引列长度上限（字符）——超长正文切词后截断，防单条撑爆索引与内存。 */
export const MAX_TOKENS_CHARS = 64 * 1024;

/** 图片占位（`[图片](url)`）——整体匹配，URL 在括号里不跨行。 */
const IMAGE_PLACEHOLDER = /\[图片\]\(([^)\n]*)\)/g;

/** 连续拉丁字母/数字/下划线——整段当一个 token（jieba 会把数字串拆成单个数字，必须先摘出来）。 */
const ASCII_RUN = /[A-Za-z0-9_]+/g;

/** CJK 表意文字与假名——二元组只在这类字符上取。 */
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/** 切词后剔除的字符：标点、空白、控制字符、零宽字符。 */
const NOISE_CHARS = /[\p{P}\p{S}\p{C}\s]+/gu;

/** 图片占位替换后的占位词——URL 不进词袋，只留「这条批有图」这个事实。 */
const IMAGE_WORD = "图片";

/** 把一段文本切成 FTS5 可索引的 token 串（空格分隔）。
 *
 * @param text 待切文本
 * @returns token 串；无可索引字符时返回空串（FTS5 空索引行不匹配任何查询，不是错误）
 */
function cutToTokens(text: string): string {
  // 超长正文先夹到输出上限的一个保守倍数再切——切词是同步 CPU 活（200k 字要约 120ms），
  // 而进站路径在事件循环上；反正结果最终也只留 MAX_TOKENS_CHARS，多算的部分全是浪费。
  const bounded = text.length > MAX_TOKENS_CHARS * 2 ? text.slice(0, MAX_TOKENS_CHARS * 2) : text;
  // ① 拉丁/数字整段摘出（jieba 会拆数字串；大小写交给 FTS5 unicode61 的大小写不敏感处理）
  const ascii = bounded.match(ASCII_RUN) ?? [];
  // ② 摘掉拉丁段，剩下的交给 jieba——它只看见汉字与标点，不会被英文干扰
  const hanOnly = bounded.replace(ASCII_RUN, " ");
  // ③ jieba 搜索引擎模式切词：比 cut 多产出较短粒度的词（「英语课群」→ 英语/英语课/群）
  const words = jieba
    .cutForSearch(hanOnly, false)
    .map((w) => w.replace(NOISE_CHARS, ""))
    .filter((w) => w.length >= 2);
  // ④ 二元组：在「去掉全部空白后的汉字串」上取——空格/换行不影响（CJK 检索本就不看空白）
  const cjk = Array.from(hanOnly)
    .filter((ch) => CJK_CHAR.test(ch))
    .join("");
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < cjk.length; i++) bigrams.push(cjk.slice(i, i + 2));
  // ⑤ 单字不入袋（纯噪声，且匹配不到）——但二元组已覆盖两字词的召回
  const tokens = new Set<string>([...words, ...bigrams, ...ascii]);
  const joined = [...tokens].join(" ");
  return joined.length > MAX_TOKENS_CHARS ? joined.slice(0, MAX_TOKENS_CHARS) : joined;
}

/** 内容切词（索引用）：图片占位整体替换为「图片」→ jieba 词 + 二元组 + 拉丁段。
 *
 * @param content 批次原文（逐字保留，不改）
 * @returns token 串；正文全是非索引字符时返回空串（FTS5 空索引行不匹配任何查询，不是错误）
 */
export function tokenizeContent(content: string): string {
  return cutToTokens(content.replace(IMAGE_PLACEHOLDER, IMAGE_WORD));
}

/** 身份词袋（索引用）：身份字典的**键名与值**共同构成词袋——形状无关。
 *
 * 为何键名也要进袋：不同信源的身份形状不同（nc 有 groupId/sender，邮件有发件地址，
 * 网页有站点名）。键名进袋后，AI 搜「群」「图书馆」「groupId」都能命中，且不必知道
 * 该信源用了哪个键——这是「统一不同信源不同形状」的机械实现。
 *
 * @param identity 身份字典（弹性，保留键 displayName）
 * @returns token 串；身份为空时返回空串
 */
export function tokenizeIdentity(identity: Identity): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(identity)) {
    parts.push(key);
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
  }
  return cutToTokens(parts.join(" "));
}
