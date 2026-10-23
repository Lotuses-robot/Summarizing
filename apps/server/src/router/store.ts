import { z } from "zod";
import { getRelaySetting, setRelaySetting } from "../storage/relay-kv";
import type { RegistryDb } from "../storage/registry";

// 接入的数据面（D-134）：**每个接入各持一份**绑定表与分发开关，按 `kind` 分区存储。
//
// 为什么按 kind 分区：Router 不只服务微信客服——将来会有校内新闻、公开网站等广播式接入。
// 它们的「订阅者标识」语义各不相同（微信是 external_userid，新闻源可能是站点+栏目），
// 挤在同一张表里就分不清谁是谁；一个开关也管不了两种源（关掉微信不该连带关掉新闻）。
//
// 为什么实现共用一份：两种源需要的形状是同一件事——「一个外部标识 → 一个账户」+「某账户收不收」。
// 让每个源各写一遍 JSON KV 读写只会得到 N 份会各自漂移的代码。所以这里提供**工厂**：
// 每个接入在构造时用 `makeBindingStore(db, kind)` 造出自己那一份，对外仅暴露接口。

/** 绑定表：外部标识 → uid。
 *
 *  为什么整张表存成一个 JSON 串而不是一行一个：客户数量级是「几个」，一行一个要额外维护
 *  表结构；而这个值只在接入侧读写，形状归接入自己，storage 只做哑 KV（D-84 同款原则）。 */
export interface BindingStore {
  /** 查一个外部标识绑到哪个账户；未绑定返回 null。 */
  resolve(code: string): string | null;
  /** 建立/覆盖一条绑定。同一标识重复绑会覆盖（后写为准），并留痕——不静默改归属。 */
  set(code: string, uid: string): void;
  /** 解除一条绑定；不存在时幂等成功。 */
  remove(code: string): void;
  /** 某账户名下的全部绑定（按字典序）。 */
  listFor(uid: string): string[];
  /** 全部绑定（运维排查用）。 */
  listAll(): Array<{ code: string; uid: string }>;
}

/** 分发开关：某账户收不收这一种接入的消息。
 *
 *  为什么它**不是**「清掉绑定」：两者对客户说的话不一样——
 *  开关关着 → 回「接收方暂不可用」（客户知道人还在，只是暂时收不了）；
 *  没绑定 → 回一串绑定码（客户要去把它交给账户主人）。
 *  把开关做成「删绑定」会让一个只是暂时停用的人，害客户收到一串莫名其妙的码。 */
export interface DeliverySwitch {
  /** 某账户当前是否接收（默认开——未设置 = 开，新账户无需先点开关）。 */
  isEnabled(uid: string): boolean;
  /** 打开/关闭（幂等；重复设同一值不写库）。 */
  set(uid: string, enabled: boolean): void;
}

/** 绑定表的形状：外部标识 → uid。 */
const BindingsSchema = z.record(z.string(), z.string());

/** 开关的形状：被关掉的 uid 数组。 */
const DisabledSchema = z.array(z.string());

/** 绑定表在这个接入下的存储键。 */
const bindingsKey = (kind: string): string => `bindings:${kind}`;

/** 开关在这个接入下的存储键。 */
const disabledKey = (kind: string): string => `delivery.disabled:${kind}`;

/** 造某个接入的绑定表。
 *
 *  **坏数据直接抛**（不兜底成空表）：绑定表是「谁的消息归谁」的唯一依据——
 *  把它当成空表继续跑，等于把**所有客户**判成未绑定、给他们全部发一遍绑定码，
 *  而那些消息会静默丢失。响亮失败让运维看见并修库，比静默发错码好得多。
 *
 *  @param db 系统库
 *  @param kind 接入名（`wecom` / `njunews` …）——同一部署里各接入互不干扰
 */
export function makeBindingStore(db: RegistryDb, kind: string): BindingStore {
  /** 读整张表。
   *
   *  @throws JSON 解析失败，或解析出的形状不是 `{ [code]: uid }`
   */
  function readAll(): Record<string, string> {
    const raw = getRelaySetting(db, bindingsKey(kind));
    if (raw === null) return {}; // 从未绑定过 = 空表（正常初始态，不是坏数据）
    const json: unknown = JSON.parse(raw); // 坏 JSON → 抛（SyntaxError）
    return BindingsSchema.parse(json); // 形状不对 → 抛（ZodError，带路径）
  }

  return {
    resolve(code: string): string | null {
      if (code === "") return null; // 空串不是合法标识（不写、不查）
      return readAll()[code] ?? null;
    },

    set(code: string, uid: string): void {
      if (code === "" || uid === "") return; // 两样都不可为空（空绑定无意义）
      const all = readAll();
      const previous = all[code];
      if (previous !== undefined && previous !== uid) {
        process.stderr.write(`[router:${kind}] 绑定覆盖：${code} 从 ${previous} 改绑到 ${uid}\n`);
      }
      all[code] = uid;
      setRelaySetting(db, bindingsKey(kind), JSON.stringify(all));
    },

    remove(code: string): void {
      const all = readAll();
      if (all[code] === undefined) return;
      delete all[code];
      setRelaySetting(db, bindingsKey(kind), JSON.stringify(all));
    },

    listFor(uid: string): string[] {
      return Object.entries(readAll())
        .filter(([, bound]) => bound === uid)
        .map(([code]) => code)
        .sort();
    },

    listAll(): Array<{ code: string; uid: string }> {
      return Object.entries(readAll()).map(([code, uid]) => ({ code, uid }));
    },
  };
}

/** 造某个接入的分发开关。 */
export function makeDeliverySwitch(db: RegistryDb, kind: string): DeliverySwitch {
  /** 读被关掉的账户集合。
   *
   *  **坏数据直接抛**（静默当成空集 = 把所有关掉的开关偷偷打开）。
   */
  function readDisabled(): Set<string> {
    const raw = getRelaySetting(db, disabledKey(kind));
    if (raw === null) return new Set(); // 从未关过 = 空集（正常初始态）
    const json: unknown = JSON.parse(raw); // 坏 JSON → 抛
    return new Set(DisabledSchema.parse(json)); // 形状不对 → 抛
  }

  return {
    isEnabled(uid: string): boolean {
      return !readDisabled().has(uid);
    },

    set(uid: string, enabled: boolean): void {
      if (uid === "") return; // 空 uid 无意义（不写）
      const disabled = readDisabled();
      const changed = enabled ? disabled.delete(uid) : disabled.add(uid);
      if (!changed) return;
      setRelaySetting(db, disabledKey(kind), JSON.stringify([...disabled].sort()));
    },
  };
}
