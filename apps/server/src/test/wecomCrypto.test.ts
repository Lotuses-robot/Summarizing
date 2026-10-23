import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  callbackSignature,
  decryptCallback,
  signatureMatches,
  xmlField,
} from "../router/wecom/crypto";

// 企业微信回调加解密（D-128）。这里用**加密端**现造报文来测解密端——两边独立实现同一套
// 协议（就像企业微信服务器真的发来一样），比手写固定密文更能发现协议理解偏差。

/** 43 位 EncodingAESKey（base64 字符集去掉末尾 =）。 */
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG".slice(0, 43);
const CORP_ID = "ww1234567890abcdef";

/** 按协议加密一条明文（测试用加密端）：random(16) + msgLen(4,BE) + msg + receiveId，PKCS#7(32)。 */
function encryptForTest(msg: string, receiveId: string): string {
  const key = Buffer.from(`${AES_KEY}=`, "base64");
  const iv = key.subarray(0, 16); // 官方：IV = AESKey 前 16 字节
  const msgBuf = Buffer.from(msg, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const random = crypto.randomBytes(16);
  const body = Buffer.concat([random, lenBuf, msgBuf, Buffer.from(receiveId, "utf8")]);
  // PKCS#7，块大小 32
  const padLen = 32 - (body.length % 32);
  const padded = Buffer.concat([body, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

describe("企业微信回调加解密", () => {
  it("解密：还原 XML 与 receiveId", () => {
    const xml =
      "<xml><ToUserName><![CDATA[ww1]]></ToUserName><Event><![CDATA[kf_msg_or_event]]></Event></xml>";
    const encrypted = encryptForTest(xml, CORP_ID);
    const out = decryptCallback(encrypted, AES_KEY);
    expect(out.xml).toBe(xml);
    expect(out.receiveId).toBe(CORP_ID);
  });

  it("签名：sha1(sort([token,timestamp,nonce,encrypt]))", () => {
    const sig = callbackSignature("tok", "1600000000", "nonce", "ENCRYPTED");
    const expected = crypto
      .createHash("sha1")
      .update(["tok", "1600000000", "nonce", "ENCRYPTED"].sort().join(""))
      .digest("hex");
    expect(sig).toBe(expected);
  });

  it("签名比较：相等为真、不等为假（大小写不敏感）", () => {
    expect(signatureMatches("abcdef", "ABCDEF")).toBe(true);
    expect(signatureMatches("abcdef", "abcdee")).toBe(false);
    expect(signatureMatches("abc", "abcd")).toBe(false); // 长度不同也不抛
  });

  it("EncodingAESKey 长度不对 → 抛（配置错误要响亮）", () => {
    expect(() => decryptCallback("AAAA", "tooshort")).toThrow(/EncodingAESKey/);
  });

  it("密文长度非法 → 抛（不是可解的形状）", () => {
    expect(() => decryptCallback(Buffer.alloc(10).toString("base64"), AES_KEY)).toThrow(/长度/);
  });

  it("篡改密文 → 填充校验失败（不静默返回垃圾）", () => {
    const encrypted = encryptForTest("<xml><Event>kf_msg_or_event</Event></xml>", CORP_ID);
    const buf = Buffer.from(encrypted, "base64");
    // 破坏最后一个字节（密文块尾部），解密后填充极可能非法
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptCallback(buf.toString("base64"), AES_KEY)).toThrow();
  });
});

describe("回调 XML 取值", () => {
  it("取 CDATA 包裹的字段", () => {
    expect(xmlField("<xml><Event><![CDATA[kf_msg_or_event]]></Event></xml>", "Event")).toBe(
      "kf_msg_or_event",
    );
  });

  it("取普通文本字段并解 XML 实体", () => {
    expect(xmlField("<xml><Content>a &amp; b</Content></xml>", "Content")).toBe("a & b");
  });

  it("缺失字段 → null（不编造）", () => {
    expect(xmlField("<xml><A>1</A></xml>", "Event")).toBeNull();
  });

  it("同名标签取第一个（报文形状异常时保守）", () => {
    expect(xmlField("<xml><E>first</E><E>second</E></xml>", "E")).toBe("first");
  });
});

describe("官方样例（黄金测试向量）", () => {
  // 取值自官方《加解密方案说明》的完整示例——用它钉住协议实现：
  // 任何一处（IV 取法 / 填充块大小 / 明文结构）走偏，这组断言立刻红。
  const OFFICIAL_KEY = "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C";
  const OFFICIAL_TOKEN = "QDG6eK";
  const OFFICIAL_CORP = "wx5823bf96d3bd56c7";
  const OFFICIAL_ENCRYPT =
    "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==";

  it("签名与官方示例一致", () => {
    expect(callbackSignature(OFFICIAL_TOKEN, "1409659813", "1372623149", OFFICIAL_ENCRYPT)).toBe(
      "477715d11cdb4164915debcba66cb864d751f3e6",
    );
  });

  it("解密出官方给的明文 XML 与 receiveId", () => {
    const out = decryptCallback(OFFICIAL_ENCRYPT, OFFICIAL_KEY);
    expect(out.receiveId).toBe(OFFICIAL_CORP);
    expect(out.xml).toContain("<Content><![CDATA[hello]]></Content>");
    expect(out.xml).toContain("<MsgType><![CDATA[text]]></MsgType>");
    expect(xmlField(out.xml, "Content")).toBe("hello");
  });
});
