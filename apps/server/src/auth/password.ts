import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

// 密码哈希（006 R2 / D-96）：node:crypto 的 scrypt（OpenSSL 实现，非自造密码学）——
// 零新原生依赖（便携包/ Docker 打包零改动），参数自描述可平滑调参。登录低频，~50-100ms 可接受。

const SCRYPT_N = 32_768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAX_MEM = 64 * 1024 * 1024; // 容纳 N=2^15,r=8 的工作区（缺省 32MiB 会报错）

/** scrypt 回调式 → Promise（自包一层；promisify 的重载推断不可靠）。 */
function scryptAsync(
  password: string,
  salt: Buffer,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, { ...opts, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** 生成密码哈希：自描述格式 `scrypt$N,r,p$salt_b64$hash_b64`（校验按串内参数跑，调参不动旧哈希）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N},${SCRYPT_R},${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** 校验密码：格式坏/参数坏/比对失败都返回 false（不抛——调用方统一按「凭据错误」处理）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const [nStr, rStr, pStr] = (parts[1] ?? "").split(",");
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N <= 1 ||
    N > 2 ** 20
  ) {
    return false;
  }
  const salt = Buffer.from(parts[2] ?? "", "base64");
  const expected = Buffer.from(parts[3] ?? "", "base64");
  if (expected.length !== KEY_LEN) return false;
  try {
    const actual = await scryptAsync(password, salt, { N, r, p });
    return timingSafeEqual(actual, expected); // 长度相同才有意义（上面已查）
  } catch {
    // 参数大到超 maxmem 等情况：按校验失败处理（不泄露内部错误）
    return false;
  }
}

let dummyHash: string | null = null;

/** 用户名不存在时的**哑校验**：磨掉与真校验相同的成本，不泄露「此人是否存在」（006 R2）。 */
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= await hashPassword("dummy-password-for-timing-equalization");
  await verifyPassword(password, dummyHash);
}
