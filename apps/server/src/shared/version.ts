// 应用版本号（011）：单一出处 = CHANGELOG.md 的首个版本标题，构建时由 scripts/build-server.mjs
// 注入常量 __APP_VERSION__（便携包与 Docker 共用同一条构建线）。
// 开发态（tsx / vitest）没有构建注入——回退 "dev"，不读 package.json（两套真相会漂移）。

declare const __APP_VERSION__: string | undefined;

/** 当前应用版本（如 "0.5.0"）；开发态无构建注入时为 "dev"。 */
export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}
