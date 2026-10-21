import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { SettingField, SourceSummary } from "@summarizing/shared";
import { errText } from "@summarizing/shared";
import { api } from "../../api";
import { fmtAgo, fmtFullTime } from "../../lib/time";
import { Card, Row, StatusSlot, useStatus } from "./primitives";
/** 每源的一句话接入引导（**源自己的知识**——怎么写进 nc 的 WebUI；未知源不显示，
 *  将来源多了可由适配器声明下发。用户 2026-10-03：引导是每个源自己的事）。 */
const SOURCE_HINTS: Record<string, string> = {
  nc: "填进 nc 的「网络配置 → HTTP 服务器 → 反向 WebSocket / HTTP 上报」，勾选「群消息」；再在下方白名单填群号。",
};

/** record 值判据：非 null、非数组的对象（键值地图形状）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 活动时刻的相对说法（「N 分钟前」）；从未有记录 → 「从未」。 */
function agoText(iso: string | undefined): string {
  if (iso === undefined) return "从未";
  return fmtAgo(iso) ?? iso;
}

/** 活动时刻的精确说法（悬浮提示用）；从未有记录 → 「从未」。 */
function fullAt(iso: string | undefined): string {
  return iso === undefined ? "从未" : fmtFullTime(iso);
}

/** 卡头活动信号：HTTP 源「收到」在前（源还在推是更强的活信号），所有源都带「入库」。
 *  给的是事实而不是判断：安静多久由用户自己看。 */
function activityLabel(summary: SourceSummary): string {
  const ingest =
    summary.lastIngestAt === undefined ? "从未入库" : `入库 ${agoText(summary.lastIngestAt)}`;
  if (summary.hookPath === null) return ingest;
  const received =
    summary.lastEventAt === undefined ? "从未收到" : `收到 ${agoText(summary.lastEventAt)}`;
  return `${received} · ${ingest}`;
}

/** 卡头活动信号的悬浮全文（精确时刻；无 webhook 的源没有「收到」一说）。 */
function activityTitle(summary: SourceSummary): string {
  const parts: string[] = [];
  if (summary.hookPath !== null) parts.push(`收到：${fullAt(summary.lastEventAt)}`);
  parts.push(`入库：${fullAt(summary.lastIngestAt)}`);
  return parts.join(" · ");
}

/** 单字段输入（判别联合五型分支渲染——record 由调用方分流给 RecordEditor；前端不含信源专属知识，全按 schema 走）。
 *  写语义（走查修订③）：开关/下拉点了即存；输入框失焦即存（onCommit）；number 的非法态
 *  （"-"、"8e" 等 badInput）走 onInvalid 拒存——**不当成清空**（评审 M5）。
 *  raw→值的换算只在组件内做一次，对外交出的就是值（simplify 评审：协议别拆两层各写一半）。 */
function FieldInput({
  field,
  value,
  onChange,
  onCommit,
  onInvalid,
}: {
  field: Exclude<SettingField, { type: "record" }>;
  value: unknown;
  /** 本地值更新（受控输入）。 */
  onChange: (v: unknown) => void;
  /** 写：boolean/select 点了即存；number/text/secret 失焦即存——值已归一（number 空 = undefined = 回默认）。 */
  onCommit: (v: unknown) => void;
  /** number 非法态拒存提示（badInput——"-"、"8e" 这类输入框自报非法的情形）。 */
  onInvalid: () => void;
}) {
  if (field.type === "boolean") {
    return (
      <input
        type="checkbox"
        className="h-[1rem] w-[1rem] accent-accent"
        checked={value === true}
        onChange={(e) => {
          onChange(e.target.checked);
          onCommit(e.target.checked);
        }}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select
        className="input w-[14rem] max-w-full"
        value={typeof value === "string" ? value : (field.default ?? "")}
        onChange={(e) => {
          onChange(e.target.value);
          onCommit(e.target.value);
        }}
      >
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "number") {
    return (
      <input
        type="number"
        className="input w-[7rem]"
        value={typeof value === "number" ? String(value) : ""}
        placeholder={field.default === undefined ? "" : String(field.default)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        onBlur={(e) => {
          if (e.target.validity.badInput) {
            onInvalid();
            return;
          }
          onCommit(e.target.value === "" ? undefined : Number(e.target.value));
        }}
      />
    );
  }
  // text / secret（secret 用密码型输入——后端 GET 仍会明文回吐，见台账 L21）
  return (
    <input
      type={field.type === "secret" ? "password" : "text"}
      className="input w-[18rem] max-w-full"
      value={typeof value === "string" ? value : ""}
      placeholder={field.default ?? ""}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit(e.target.value)}
    />
  );
}

/** record 字段的行编辑器（键值对，用户选甲）：值以 [k,v][] 行态承载；
 *  改动（输入失焦/加行/删行）整对象落库——空键行丢弃。
 *  删除按钮 in mousedown 阻止默认（评审 M6）：不先 blur 提交再 click 提交——只发一次。 */
function RecordEditor({
  rows,
  onChange,
  onCommit,
  keyPlaceholder = "键",
  valuePlaceholder = "值",
}: {
  rows: [string, string][];
  onChange: (rows: [string, string][]) => void;
  onCommit: (rows: [string, string][]) => void;
  /** 键列语义占位（schema 可给；缺省「键」）——如 nc 的「群号」，直接防填反（A14）。 */
  keyPlaceholder?: string;
  /** 值列语义占位（缺省「值」）。 */
  valuePlaceholder?: string;
}) {
  /** 半成品行（有键无值/有值无键）——只提示不动数据（评审 M3c：用户以为存上了）。 */
  const halfBaked = rows.some(([k, v]) => {
    const kk = k.trim();
    const vv = v.trim();
    return (kk !== "" && vv === "") || (kk === "" && vv !== "");
  });
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      {rows.map(([k, v], i) => (
        <div
          key={i}
          className="group flex items-center border-t border-line transition-colors first:border-t-0 focus-within:ring-1 focus-within:ring-inset focus-within:ring-accent"
        >
          <input
            className="w-[9rem] max-w-[45%] shrink-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-ink-muted"
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
            onBlur={() => onCommit(rows)}
          />
          <div className="flex min-w-0 flex-1 items-center self-stretch border-l border-line">
            <input
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-ink-muted"
              value={v}
              placeholder={valuePlaceholder}
              onChange={(e) => onChange(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
              onBlur={() => onCommit(rows)}
            />
            <button
              className="mr-1.5 inline-flex h-[1.5rem] w-[1.5rem] shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-muted opacity-0 transition hover:bg-danger-soft hover:text-danger focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
              title="删这一行"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const next = rows.filter((_, j) => j !== i);
                onChange(next);
                onCommit(next);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
      {/* 幽灵行：与表体一体、无边框，hover 才显色——比又一个带框按钮轻得多（列表空时即唯一一行） */}
      <button
        className="flex w-full cursor-pointer items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-ink-muted transition-colors first:border-t-0 hover:bg-canvas hover:text-accent"
        onClick={() => onChange([...rows, ["", ""]])}
      >
        <Plus size={12} /> 添加一行
      </button>
      {halfBaked && (
        <p className="border-t border-line px-3 py-1.5 text-xs text-ink-muted">
          有未填完整的行（键和值都要）——补齐后才会生效
        </p>
      )}
    </div>
  );
}

/** 单个信源卡（macOS 式分组卡 + 改完即生效）：卡头 = 源名 + 状态；**顶部自带接入地址**（后端下发的
 *  hookPath，前端零拼接）与该源自己的接入引导；卡内一行一设置。
 *  写语义：与「已存值」不同才写，**发出即以新值为基线**（在飞不再按旧基线重复发），
 *  失败回滚基线并常驻红字；数字清空 = DELETE 回默认；成功一闪「已保存」。 */
function SourceCard({ summary }: { summary: SourceSummary }) {
  const { statuses, flash, sticky } = useStatus();
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [initial, setInitial] = useState<Record<string, unknown>>({}); // 已（乐观）落库值（diff 基准）
  const [recordRows, setRecordRows] = useState<Record<string, [string, string][]>>({});
  const [readFailed, setReadFailed] = useState(false);
  /** 复制接入地址（剪贴板不可用/失败 → 可见提示，不静默）。 */
  const copyHook = () => {
    if (summary.hookPath === null) return;
    const hookUrl = `${window.location.origin}${summary.hookPath}`;
    if (navigator.clipboard === undefined) {
      sticky("hook", "剪贴板不可用——请手动选中复制");
      return;
    }
    navigator.clipboard
      .writeText(hookUrl)
      .then(() => flash("hook", "已复制"))
      .catch(() => sticky("hook", "复制失败——请手动选中复制"));
  };

  useEffect(() => {
    if (summary.settings.length === 0) {
      setValues({});
      return;
    }
    api
      .sourceSettings(summary.name)
      .then((v) => {
        setValues(v);
        setInitial(v);
        const rows: Record<string, [string, string][]> = {};
        for (const f of summary.settings) {
          if (f.type !== "record") continue;
          const cur = v[f.key];
          rows[f.key] = isPlainObject(cur)
            ? Object.entries(cur).map(([k, val]) => [k, String(val)])
            : [];
        }
        setRecordRows(rows);
      })
      .catch(() => setReadFailed(true));
  }, [summary]);

  /** 写基线的唯一变更口：v === undefined = 删键（回到未设置）。乐观先记、失败回滚、DELETE 交付共用。 */
  const setBaseline = (key: string, saved: unknown) => {
    setInitial((prev) => {
      const next = { ...prev };
      if (saved === undefined) delete next[key];
      else next[key] = saved;
      return next;
    });
  };

  /** 写管道：成功一闪 / 失败回滚基线 + 常驻红字（不静默）——两处 commit 共用同一策略。 */
  const write = (
    f: SettingField,
    before: unknown,
    run: () => Promise<void>,
    okMsg: string,
    failMsg: string,
  ) => {
    run()
      .then(() => flash(f.key, okMsg))
      .catch((err: unknown) => {
        setBaseline(f.key, before);
        sticky(f.key, `${failMsg}：${errText(err)}`);
      });
  };

  /** 写一个标量（失焦/点选触发）：与基线不同才写；清空 = DELETE 回默认。
   *  乐观更新基线（评审 M：旧基线会让快速二次提交算错 diff；值域 string|number|boolean，=== 即等）。 */
  const commitScalar = (f: SettingField, next: unknown) => {
    const before = initial[f.key];
    if (next === undefined) {
      if (before === undefined) return; // 已是空的再清空：不发
      setBaseline(f.key, undefined); // 乐观：先记「回到未设置」
      write(
        f,
        before,
        () => api.deleteSourceSetting(summary.name, f.key),
        `「${f.label}」已恢复默认`,
        `「${f.label}」恢复默认失败`,
      );
      return;
    }
    if (next === before) return;
    setBaseline(f.key, next);
    write(
      f,
      before,
      () => api.setSourceSetting(summary.name, f.key, next),
      "已保存",
      `「${f.label}」保存失败`,
    );
  };

  /** record 行 → 对象（空键丢弃；值保持字符串——白名单语义即「群号: 备注名」）。 */
  const rowsToObject = (rows: [string, string][]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of rows) {
      const kk = k.trim();
      if (kk !== "") out[kk] = v;
    }
    return out;
  };

  /** 写一个 record（失焦/加删行触发）：与基线不同才写（未设置 ≡ 空对象）。 */
  const commitRecord = (f: SettingField, rows: [string, string][]) => {
    const obj = rowsToObject(rows);
    const before = initial[f.key];
    const beforeObj = isPlainObject(before) ? before : {};
    if (JSON.stringify(obj) === JSON.stringify(beforeObj)) return;
    setBaseline(f.key, obj);
    write(
      f,
      before,
      () => api.setSourceSetting(summary.name, f.key, obj),
      "已保存",
      `「${f.label}」保存失败`,
    );
  };

  const headerChip =
    summary.state === "error" ? (
      <span className="chip shrink-0 border-danger/50 text-danger" title={summary.lastError ?? ""}>
        最近出错
      </span>
    ) : (
      <span className="chip shrink-0" title={activityTitle(summary)}>
        {activityLabel(summary)}
      </span>
    );

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {summary.name}
          {headerChip}
        </span>
      }
      desc={
        summary.state === "error"
          ? `${summary.lastError ?? "未知错误"}${
              summary.lastErrorAt === undefined
                ? ""
                : `（${fmtAgo(summary.lastErrorAt) ?? fmtFullTime(summary.lastErrorAt)}）`
            }`
          : undefined
      }
    >
      {/* 接入地址 + 该源自己的引导（hookPath 由后端算好——URL 形状是源的知识，前端零拼接） */}
      {summary.hookPath !== null && (
        <Row label="接入地址" description={SOURCE_HINTS[summary.name]} stacked>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-md border border-line bg-canvas px-2 py-1 text-xs">
              {window.location.origin}
              {summary.hookPath}
            </code>
            <button className="btn" onClick={copyHook}>
              复制
            </button>
          </div>
        </Row>
      )}
      {summary.settings.length === 0 ? (
        <Row label={<span className="text-ink-muted">这个信源没有可配置项</span>} />
      ) : readFailed ? (
        <Row label={<span className="text-danger">设置读取失败（后端是否在跑？）</span>} />
      ) : values === null ? (
        <Row label={<span className="text-ink-muted">读取设置中…</span>} />
      ) : (
        <>
          {summary.settings.map((f) => (
            <Row
              key={f.key}
              label={f.label}
              description={f.description}
              stacked={f.type === "record"}
            >
              {f.type === "record" ? (
                <RecordEditor
                  rows={recordRows[f.key] ?? []}
                  onChange={(rows) => setRecordRows((cur) => ({ ...cur, [f.key]: rows }))}
                  onCommit={(rows) => commitRecord(f, rows)}
                  keyPlaceholder={f.keyPlaceholder}
                  valuePlaceholder={f.valuePlaceholder}
                />
              ) : (
                <FieldInput
                  field={f}
                  value={values[f.key]}
                  onChange={(v) => setValues((cur) => ({ ...(cur ?? {}), [f.key]: v }))}
                  onCommit={(v) => commitScalar(f, v)}
                  onInvalid={() => sticky(f.key, `「${f.label}」不是合法数字，未保存`)}
                />
              )}
            </Row>
          ))}
          {/* 状态槽：有保存反馈才出现（无则整槽不渲染——走查 2026-10-03） */}
          <StatusSlot statuses={statuses} />
        </>
      )}
    </Card>
  );
}

/** 信源列表三态（simplify：平铺 early-return）。空/加载态不套带底色的 Panel（避免在设置里
 *  像「多出一行空白」）——用与设置其它空态一致的朴素灰字。 */
function SourcesList({
  error,
  sources,
}: {
  error: string | null;
  sources: SourceSummary[] | null;
}) {
  if (error !== null) {
    return <p className="px-0.5 text-sm text-danger">{error}</p>;
  }
  if (sources === null) {
    return <p className="px-0.5 text-sm text-ink-muted">加载信源…</p>;
  }
  if (sources.length === 0) {
    return <p className="px-0.5 text-sm text-ink-muted">还没有接入信源</p>;
  }
  return (
    <div className="space-y-5">
      {sources.map((s) => (
        <SourceCard key={s.name} summary={s} />
      ))}
    </div>
  );
}

/** 信源区（D-89 真界面 / 走查修订③ 即时生效）：GET /api/sources 列信源 → 每源一张分组卡。
 *  前端不知道信源名——列表与字段全部由后端给。
 *  （接入地址/令牌轮换已移入**用户卡**——账户级事实不属信源区，用户 2026-10-03 定。） */
export function SourcesSection() {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sources()
      .then(setSources)
      .catch(() => setError("拉取信源列表失败（后端是否在跑？）"));
  }, []);

  return (
    <div className="space-y-5">
      <SourcesList error={error} sources={sources} />
    </div>
  );
}
