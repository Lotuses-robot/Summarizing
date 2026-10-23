import { getRelaySetting, setRelaySetting } from "../storage/relay-kv";
import type { RegistryDb } from "../storage/registry";

// Router 的部署级设置（D-130）：凭据与参数**只在运维命令行**配，不进任何账户的设置页
// （FR-040——微信的 secret 属于部署方，不属于任何一个用户）。
//
// 存进 `system.db` 的 `relay_settings`（不是账户库的 `app_settings`）：Router 是部署级单例，
// 它的凭据全局一份。两套 KV 的边界见 storage/relay-kv.ts 文件头。

/** 一条部署级设置项。 */
interface RouterSettingSpec {
  key: string;
  label: string;
  /** 是不是凭据（`router:list` 只显示尾 4 位——运维能看出「配没配、是哪把」，但看不全）。 */
  secret: boolean;
  /** 数值型设置（写入时校验：必须是正数——错填当场拒绝，不在读取时静默修正）。 */
  positiveNumber?: true;
}

/** Router 的设置项清单（`router:set` 认的键、`router:list` 的展示顺序）。
 *
 *  为什么要这份清单而不是随便写键：写错一个键名的配置**永远不生效**，而且没有任何地方会报错
 *  ——那是「配了但没用」的黑洞。清单让 `router:set` 当场拒绝不认识的键。 */
const ROUTER_SETTINGS: RouterSettingSpec[] = [
  { key: "wecom.corpId", label: "企业 ID（corpId）", secret: false },
  { key: "wecom.secret", label: "应用 Secret", secret: true },
  { key: "wecom.callbackToken", label: "回调 Token", secret: true },
  { key: "wecom.encodingAesKey", label: "回调 EncodingAESKey", secret: true },
  { key: "wecom.openKfids", label: "客服账号 id（逗号分隔）", secret: false },
  {
    key: "wecom.replyThrottleMinutes",
    label: "回执最小间隔（分钟）",
    secret: false,
    positiveNumber: true,
  },
];

/** 键 → 声明（`router:set` 校验与 `router:list` 掩码共用）。 */
const SETTING_BY_KEY = new Map(ROUTER_SETTINGS.map((s) => [s.key, s]));

/** 读一条部署级设置；未设置返回 null（不兜空串——调用方要能分辨「没配」与「配了空值」）。 */
export function readRouterSetting(db: RegistryDb, key: string): string | null {
  return getRelaySetting(db, key);
}

/** 写一条部署级设置。**写入即校验**（D-103：用户的错填当场判错，不留到运行时静默失效）。
 *
 *  @throws 键不在 `ROUTER_SETTINGS` 里，或数值型设置给了非正数
 */
export function writeRouterSetting(db: RegistryDb, key: string, value: string): void {
  const spec = SETTING_BY_KEY.get(key);
  if (spec === undefined) {
    throw new Error(
      `未知的 Router 设置项：${key}（可用：${ROUTER_SETTINGS.map((s) => s.key).join(" / ")}）`,
    );
  }
  if (spec.positiveNumber === true) {
    const n = Number(value.trim());
    if (value.trim() === "" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`「${spec.label}」必须是正数（收到 ${JSON.stringify(value)}）`);
    }
  }
  setRelaySetting(db, key, value);
}

/** 列出**本轮登记过的**设置项及其当前值（凭据只留尾 4 位；未配置的显示「未配置」）。
 *
 *  按 `ROUTER_SETTINGS` 的顺序全量列出（不是只列库里有的）——运维要能一眼看出**还差哪几项**。 */
export function listRouterSettings(
  db: RegistryDb,
): Array<{ key: string; label: string; value: string }> {
  return ROUTER_SETTINGS.map((spec) => {
    const raw = getRelaySetting(db, spec.key);
    return {
      key: spec.key,
      label: spec.label,
      value: raw === null ? "（未配置）" : spec.secret ? maskSecret(raw) : raw,
    };
  });
}

/** 凭据掩码：留尾 4 位（`****abcd`）。短到没有 4 位可留时整串打码——别把短密码露出来。 */
function maskSecret(value: string): string {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}
