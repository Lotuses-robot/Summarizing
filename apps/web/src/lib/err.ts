/** err → 人话（Error.message / String 兜底）。
 *  设置面曾两份各写（simplify 复用评审 #1）；服务端 digest.ts 另有一份——跨包收敛需走 shared，暂不动。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
