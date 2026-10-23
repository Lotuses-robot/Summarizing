import crypto from "node:crypto";

// 企业微信回调的加解密（D-128）：**协议级**实现，与业务无关。
//
// 企业微信（及微信、公众号）共用同一套回调加密方案（已对照官方文档 2026-10-23 逐条核实）：
//   · 签名：sha1(sort([token, timestamp, nonce, encrypt]).join(""))，与 msg_signature 比对（防篡改）。
//   · 密文：AES-256-CBC，key = base64Decode(EncodingAESKey + "=")（43 位补一个 "=" 变 32 字节），
//     **IV = AESKey 前 16 字节**（不是密文前缀！），明文用 PKCS#7（块大小 32）填充。
//   · 明文结构：random(16B) + msgLen(4B, 网络字节序) + msg + receiveId。
//     receiveId 对「自建应用/通讯录」是 corpid，对「微信客服」是 corpid（同值），
//     对公众号是 appid——**这里把 receiveId 交回调用方自己核对**：本模块不认识业务语义。
//
// 协议来源：官方《加解密方案说明》+《微信客服 → 接收消息和事件》两份文档（curl 抓取核对，
// 关键点已用官方样例做黄金测试——见 wecomCrypto.test.ts 的「官方样例」用例）。
//
// 为什么自己写而不引三方库：加解密只有 ~40 行，且要精确控制「签名不匹配就拒绝」的时序；
// 引一个三方库反而把「它到底校不校验签名」变成不可见的前提。

/** 解密后的一条回调明文。 */
export interface CallbackPayload {
  /** 明文里的业务 XML（企业微信回调的正文是 XML 串）。 */
  xml: string;
  /** 明文尾部的 receiveId（corpid / appid）——调用方必须核对它等于自己的企业 id。 */
  receiveId: string;
}

/** 计算回调签名：sha1(sort([token, timestamp, nonce, encrypt]).join(""))。
 *
 * @param token 回调 Token（企业微信后台配置）
 * @param timestamp 回调 query 里的 timestamp
 * @param nonce 回调 query 里的 nonce
 * @param encrypt 密文（query 或 XML 里的 Encrypt 字段）
 */
export function callbackSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): string {
  const sorted = [token, timestamp, nonce, encrypt].sort().join("");
  return crypto.createHash("sha1").update(sorted).digest("hex");
}

/** 定长比较（防时序侧信道；签名是公开的，但这行成本几乎为零，没理由留一个奇怪的比较）。 */
export function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(actual.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** EncodingAESKey（43 位）→ 32 字节 key。长度不对直接抛（配置错误要响亮，不静默兜底）。 */
function aesKey(encodingAesKey: string): Buffer {
  const normalized = encodingAesKey.endsWith("=") ? encodingAesKey : `${encodingAesKey}=`;
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32) {
    throw new Error(`EncodingAESKey 不合法（解出 ${key.length} 字节，应为 32）——检查是否为 43 位`);
  }
  return key;
}

/** 解一条回调密文。
 *
 * ⚠️ **IV 不是密文的前 16 字节**——官方文档明确：「IV 初始向量大小为 16 字节，**取 AESKey 前 16 字节**」，
 *   密文从一开始就是纯 AES 输出（没有 IV 前缀）。这一点与「微信支付」等其它腾讯回调格式不同，
 *   照抄后者会解出乱码（或直接填充报错）。
 *
 * @param encryptedBase64 密文（base64）
 * @param encodingAesKey 43 位 EncodingAESKey
 * @returns 明文 XML 与 receiveId（**调用方负责核对 receiveId**）
 * @throws 密文损坏/填充非法（长度或解出的内容不合规）
 */
export function decryptCallback(encryptedBase64: string, encodingAesKey: string): CallbackPayload {
  const key = aesKey(encodingAesKey);
  const buf = Buffer.from(encryptedBase64, "base64");
  if (buf.length === 0 || buf.length % 16 !== 0) {
    throw new Error("回调密文长度不合法（应为 16 的整数倍）");
  }
  const iv = key.subarray(0, 16); // 官方文档：IV = AESKey 前 16 字节
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false); // 填充块大小是 32，Node 只认 PKCS#7(16)——自己剥
  const padded = Buffer.concat([decipher.update(buf), decipher.final()]);

  // PKCS#7（块 32）：末字节 = 填充长度（1..32），且填充字节应全部相同
  const pad = padded[padded.length - 1] ?? 0;
  if (pad < 1 || pad > 32 || pad > padded.length) throw new Error("回调密文填充非法");
  for (let i = padded.length - pad; i < padded.length; i += 1) {
    if (padded[i] !== pad) throw new Error("回调密文填充非法（填充字节不一致）");
  }
  const plain = padded.subarray(0, padded.length - pad);

  // 结构：random(16) + msgLen(4, BE) + msg + receiveId
  if (plain.length < 20) throw new Error("回调明文过短（缺 16 字节随机头 + 4 字节长度）");
  const msgLen = plain.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  if (msgEnd > plain.length) throw new Error("回调明文长度字段与实际内容不符");
  return {
    xml: plain.subarray(msgStart, msgEnd).toString("utf8"),
    receiveId: plain.subarray(msgEnd).toString("utf8"),
  };
}

/** 取 XML 里某个简单标签的文本（回调 XML 是扁平结构，不需要完整解析器）。
 *
 * 只取**第一个**匹配：企业微信回调的每个字段只出现一次；重复出现意味着报文形状异常，
 * 取第一个与「静默接受全部」相比更保守（配 `parseCallbackXml` 的形状校验一起用）。
 *
 * @param xml 回调 XML
 * @param tag 标签名（区分大小写，与官方字段名一致）
 * @returns 文本；缺失返回 null
 */
export function xmlField(xml: string, tag: string): string | null {
  // 标签名来自代码常量（不是用户输入），但仍转义以防将来有人传进变量
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<${safeTag}>([\\s\\S]*?)</${safeTag}>`).exec(xml);
  if (m === null) return null;
  return decodeCdata(m[1] ?? "").trim();
}

/** 解 CDATA 包裹（`<![CDATA[...]]>`）并还原 XML 实体（只处理回调会用的五种）。 */
function decodeCdata(raw: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw.trim());
  const text = cdata === null ? raw : (cdata[1] ?? "");
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
