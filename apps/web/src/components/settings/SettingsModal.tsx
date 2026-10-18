import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  Database,
  Filter as FilterIcon,
  Loader2,
  Palette as PaletteIcon,
  Rss,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AiSettings, AiSettingsView, AiTestResult } from "@summarizing/shared";
import { errText } from "@summarizing/shared";
import { api } from "../../api";
import { cn } from "../../lib/cn";
import { PALETTES } from "../../lib/appearance";
import { pushEscLayer } from "../../lib/escLayer";
import { Card, Row, Segmented, StatusSlot, useStatus } from "./primitives";
import { SourcesSection } from "./SourcesSection";
import {
  loadAppearance,
  updateAppearance,
  type AppearancePrefs,
  type Density,
  type FontChoice,
  type Palette,
  type ThemeMode,
} from "../../lib/appearance";

/** 六个主题色的预览取值——**值须与 index.css 亮色 `--accent` 逐一一致**（同一事实两处写，改色两边都要改）。 */
const PALETTE_COLORS: Record<Palette, string> = {
  teal: "#0f766e",
  blue: "#1d4ed8",
  green: "#15803d",
  purple: "#7c3aed",
  orange: "#c2410c",
  rose: "#be123c",
};

const PALETTE_NAMES: Record<Palette, string> = {
  teal: "青",
  blue: "蓝",
  green: "绿",
  purple: "紫",
  orange: "橙",
  rose: "玫红",
};

const THEME_NAMES: Record<ThemeMode, string> = { light: "亮", dark: "暗", system: "系统" };
const FONT_NAMES: Record<FontChoice, string> = { system: "系统默认", round: "圆黑", serif: "衬线" };
const DENSITY_NAMES: Record<Density, string> = { comfortable: "舒适", compact: "紧凑" };

// 左侧分类栏（用户 2026-09-27 定：左导航 + 右侧内容，点击定位）。
// 右侧内容 = 分组卡（macOS 系统设置式，用户 2026-09-30 走查定：一行一设置、控件右对齐、**改完即生效**）。
type SectionId = "appearance" | "ai" | "rules" | "data" | "sources";

/** 段 id → DOM 锚点 id 的**唯一出处**（JSX 挂锚点、滚动定位、联动观测都查它；漏一段编译不过）。 */
const SECTION_DOM = {
  appearance: "settings-appearance",
  ai: "settings-ai",
  rules: "settings-rules",
  data: "settings-data",
  sources: "settings-sources",
} satisfies Record<SectionId, string>;

type SectionMeta = { id: SectionId; label: string; icon: LucideIcon };
const SECTIONS: SectionMeta[] = [
  { id: "appearance", label: "外观", icon: PaletteIcon },
  { id: "ai", label: "AI", icon: Bot },
  { id: "rules", label: "收取规则", icon: FilterIcon },
  { id: "data", label: "数据", icon: Database },
  { id: "sources", label: "信源", icon: Rss },
];

/** 滚动联动判定（纯函数，可测）：给各分区「顶边相对容器顶」的距离（可正可负）——
 *  取**最接近容器顶且已进入容差带**（|top| ≤ 60 内取 top 最小者……）的一段；滚到底时容器无法再滚，
 *  末段始终差一截顶不到顶——故 `atBottom` 为真时**直接选最后一段**（用户走查 2026-10-03 的真正修法）。
 *  ⚠️ 两处教训：①曾用 rootMargin 压窄带 → 滚到底末段被摘除；②曾要求「top ≤ 0 才算已到位」
 *  → 末段永远越不过顶、点不亮。故不以「越过」为条件，用「最接近顶 + 到底兜底」。 */
export function pickActiveSection(tops: Map<string, number>, atBottom = false): SectionId | null {
  if (tops.size === 0) return null;
  if (atBottom) {
    // 滚到底：直接选顶边最靠下（= 最后一段）——它顶不到容器顶是物理必然，不该因此落选
    let last: SectionId | null = null;
    let lastY = Number.NEGATIVE_INFINITY;
    for (const [id, top] of tops) {
      if (top > lastY) {
        lastY = top;
        last = id as SectionId;
      }
    }
    return last;
  }
  // 常规：取顶边最接近容器顶的一段（|top| 最小；同距取更靠上的）
  let pick: SectionId | null = null;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const [id, top] of tops) {
    const abs = Math.abs(top);
    if (abs < bestAbs) {
      bestAbs = abs;
      pick = id as SectionId;
    }
  }
  return pick;
}

/** 设置弹层（05§五 / D-81）：居中，Esc/点外关。外观进 localStorage、AI 进 app_settings、
 *  数据区只读+备份下载、信源区真界面。系统策略不在这里——没有旋钮。
 *  交互总则（走查修订③）：**改完即生效**——下拉/色板/开关点一下即存，输入框失焦即存，
 *  卡尾状态行一闪「已保存」；失败常驻红字（不静默）。整页无「保存」按钮。
 *  ⚠️ 关闭前先 blur（评审 H1）：Esc 不产生焦点转移，「失焦即存」必须在卸载前落一次。 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prefs, setPrefs] = useState<AppearancePrefs>(loadAppearance);
  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [form, setForm] = useState({ baseUrl: "", model: "", apiKey: "" });
  /** 用户拒收规则（D-107）：自由文本；rulesDirty 记录「与盘上值不同」——失焦即存只在脏时发。 */
  const [rules, setRules] = useState("");
  const [rulesDirty, setRulesDirty] = useState(false);
  const [rulesFailed, setRulesFailed] = useState(false);
  const [busy, setBusy] = useState<"none" | "test" | "clear">("none");
  const [readFailed, setReadFailed] = useState(false);
  const { statuses, flash, sticky } = useStatus();
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("appearance");
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** 点击左栏后的滚动动画期间（ms 时间戳之前）不重算高亮——防 smooth 滚动中把它覆盖回上一段。 */
  const lockUntilRef = useRef(0);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 滚动联动左栏高亮（用户走查 2026-10-03）：滚动时把当前段的高亮跟上。
  // 判定在 pickActiveSection（纯函数）：取「顶边最接近容器顶」的段；**滚到底时直接选最后一段**
  // （末段顶不到顶是物理必然，不该因此落选）。scroll + IntersectionObserver 都触发重算（前者管
  // 同段内滚动，后者管段进出视口）。点击左栏后的滚动动画期由 lockUntilRef 挡一下，不覆盖用户选择。
  useEffect(() => {
    if (!open) return;
    const root = contentRef.current;
    if (root === null) return;
    const tops = new Map<string, number>();
    /** 用当前站距更新左栏高亮（判定权在 pickActiveSection；到底信号一并传入）。 */
    const apply = () => {
      if (Date.now() < lockUntilRef.current) return; // 点击后的滚动动画期间：不覆盖用户选中的段
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      const id = pickActiveSection(tops, atBottom);
      if (id !== null) setActiveSection(id);
    };
    /** 量一次各分区顶边相对容器顶的距离，再刷新高亮。 */
    const read = () => {
      const rootTop = root.getBoundingClientRect().top;
      for (const s of SECTIONS) {
        const el = document.getElementById(SECTION_DOM[s.id]);
        if (el !== null) tops.set(s.id, el.getBoundingClientRect().top - rootTop);
      }
      apply();
    };
    const observer = new IntersectionObserver(() => read(), { root, threshold: 0 });
    for (const s of SECTIONS) {
      const el = document.getElementById(SECTION_DOM[s.id]);
      if (el !== null) observer.observe(el);
    }
    root.addEventListener("scroll", read, { passive: true });
    read();
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", read);
    };
  }, [open]);

  /** 关闭（三条路径共用）：先 blur 触发「失焦即存」的提交，再关——Esc 否则会静默丢未失焦的输入。
   *  blur 只对当前聚焦元素生效（textarea 未聚焦时规则不会因此落盘）——补一次显式补发。 */
  const closeWithFlush = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    saveRulesRef.current();
    onCloseRef.current();
  }, []);

  /** 点左侧分类：高亮 + 右侧滚动到对应分区。末段（数据/信源）因滚动空间不够顶不到顶，
   *  `scrollIntoView` 到"能到的最靠上位置"即可；期间**锁定目标段**，防滚动中重算把它覆盖掉。 */
  const goToSection = (id: SectionId) => {
    setActiveSection(id);
    lockUntilRef.current = Date.now() + 600; // 滚动动画期间不重算（smooth ~300-500ms）
    document
      .getElementById(SECTION_DOM[id])
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  useEffect(() => {
    if (!open) return;
    // Esc 分层退出：本层只注册「层」，触发统一由 App 全局键负责（重复监听会一次 Esc 连关两层）
    const offEsc = pushEscLayer(closeWithFlush);
    // 打开时拉一次当前 AI 设置回填表单（Key 不回显，留空=沿用）；依赖只挂 open——
    // App 每 10s 轮询重渲染不该重置用户正在编辑的表单
    setReadFailed(false);
    setTestResult(null);
    api
      .aiSettings()
      .then(applyAiView)
      .catch(() => setReadFailed(true));
    api
      .rejectionRules()
      .then((v) => {
        setRules(v.rules);
        setRulesDirty(false);
        setRulesFailed(false);
      })
      .catch(() => setRulesFailed(true));
    return () => offEsc();
  }, [open, closeWithFlush]);

  /** 改外观项：立即应用 + 持久化（lib/appearance 单一入口）——外观即点即生效，无需状态提示。 */
  const change = (patch: Partial<AppearancePrefs>) => setPrefs(updateAppearance(patch));

  /** AI 设置视图回填表单（打开拉取/保存成功共用——回填策略改一处生效）。 */
  const applyAiView = (v: AiSettingsView) => {
    setAi(v);
    setForm({ baseUrl: v.baseUrl, model: v.model, apiKey: "" });
  };

  /** 拒收规则失焦即存（与 AI 区同一交互总则）：只在脏时发，失败常驻红字（不静默）。
   *  保存成功即清脏标——**下一条进站消息**就用上新规则（提示词每批重新组装，无需重启）。 */
  const saveRules = useCallback(() => {
    if (!rulesDirty) return;
    setRulesDirty(false);
    api
      .saveRejectionRules(rules)
      .then((v) => {
        setRules(v.rules);
        setRulesFailed(false);
        flash("rules", "已保存");
      })
      .catch((err: unknown) => {
        setRulesDirty(true); // 存失败则恢复脏标——下次失焦重试，不吞
        setRulesFailed(true);
        flash("rules", `保存失败：${errText(err)}`);
      });
  }, [rulesDirty, rules, flash]);
  const saveRulesRef = useRef(saveRules);
  useEffect(() => {
    saveRulesRef.current = saveRules;
  }, [saveRules]);

  // 保存管道（评审 H2）：在飞时再来的失焦记 pending，落地后补发——busy 不再吞保存。
  // ⚠️ 补发必须走 ref 取**最新** saveNow：finally 闭包是发起时那次渲染的快照，
  // 直接在闭包里递归会带旧表单值重发（测试抓出）。
  const savingRef = useRef(false);
  const pendingRef = useRef(false);

  /** 失焦/动作触发的保存：与现值不同才发；在飞则记 pending 补发（不静默吞）。
   *  普通函数即可（simplify 评审）：身份不被任何 hook 当依赖，saveNowRef 每渲染同步。 */
  const saveNow = () => {
    if (ai === null) return;
    const body = toBody(form);
    if (body.baseUrl === ai.baseUrl && body.model === ai.model && form.apiKey === "") return;
    if (savingRef.current) {
      pendingRef.current = true;
      return;
    }
    savingRef.current = true;
    api
      .saveAiSettings(body)
      .then((v) => {
        setAi(v);
        if (!pendingRef.current) {
          // 无更新的编辑在途：清 Key 输入（掩码 placeholder 生效）；baseUrl/模型保留用户文本
          setForm((f) => ({ ...f, apiKey: "" }));
          flash("save", "已保存并即时生效");
        }
      })
      .catch((err: unknown) => sticky("save", `保存失败：${errText(err)}`))
      .finally(() => {
        savingRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          saveNowRef.current();
        }
      });
  };
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  });

  // 全部 hooks 就位后才早退（hooks 规则：不许在条件分支后调用 hooks）
  if (!open) return null;

  /** 测试连接：表单值实测一次最小请求（不动当前客户端）。 */
  const runTest = () => {
    if (ai === null || busy !== "none") return;
    setBusy("test");
    setTestResult(null);
    api
      .testAiSettings(toBody(form))
      .then((r) => setTestResult(r))
      .catch((err: unknown) => sticky("test", `测试失败：${errText(err)}`))
      .finally(() => setBusy("none"));
  };

  /** 清除本账户 AI 配置：回「未配置」占位（无 .env 可回——006 每人自带 key）。 */
  const runClear = () => {
    if (ai === null || busy !== "none") return;
    // 破坏性操作：先确认并说清后果（令牌轮换同款；曾无确认，误点即断全部消化/对话）
    if (
      !window.confirm(
        "清除后本账户的 Base URL / 模型 / Key 全部删除，AI 对话与消息消化会停摆，需重新填写才恢复。确定清除？",
      )
    ) {
      return;
    }
    setBusy("clear");
    api
      .clearAiSettings()
      .then((v) => {
        applyAiView(v);
        flash("save", "已清除配置（AI 功能回到未配置）");
      })
      .catch((err: unknown) => sticky("clear", `清除失败：${errText(err)}`))
      .finally(() => setBusy("none"));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-[7vh_1rem_1rem]"
      onClick={closeWithFlush}
    >
      <div
        className="flex max-h-[86vh] w-[min(860px,94vw)] overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="flex w-36 shrink-0 flex-col border-r border-line bg-canvas p-3">
          <span className="px-2 pb-3 text-base font-semibold">设置</span>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm",
                activeSection === s.id
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10",
              )}
              onClick={() => goToSection(s.id)}
            >
              <s.icon size={15} />
              {s.label}
            </button>
          ))}
          <button className="btn mt-auto" onClick={closeWithFlush}>
            <X size={14} /> 关闭
          </button>
        </nav>

        <div
          ref={contentRef}
          // min-h-0 保 flex 子项可滚（弹层 max-h 自限高，内容超出即在本区滚动）
          className="min-h-0 min-w-0 flex-1 space-y-7 overflow-y-auto px-6 py-5"
        >
          <Card
            id={SECTION_DOM.appearance}
            icon={PaletteIcon}
            title="外观"
            desc="只存本机浏览器"
            footnote="对话面板开合与段折叠会自动记住（也存本机浏览器）。"
          >
            <Row label="主题">
              <Segmented<ThemeMode>
                value={prefs.theme}
                options={["light", "dark", "system"]}
                labels={THEME_NAMES}
                onPick={(theme) => change({ theme })}
              />
            </Row>
            <Row label="主题色">
              <div className="flex w-44 items-center justify-between">
                {PALETTES.map((p) => (
                  <button
                    key={p}
                    title={PALETTE_NAMES[p]}
                    onClick={() => change({ palette: p })}
                    className={cn(
                      // 选中用带间隙的环 + 白勾（评审 C：环色 == 填充色时原地看不见）——色盲也可辨
                      "flex h-[1.5rem] w-[1.5rem] cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-110",
                      prefs.palette === p && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
                    )}
                    style={{ backgroundColor: PALETTE_COLORS[p] }}
                  >
                    {prefs.palette === p && <Check size={12} className="text-white drop-shadow" />}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="字体">
              <Segmented<FontChoice>
                value={prefs.font}
                options={["system", "round", "serif"]}
                labels={FONT_NAMES}
                onPick={(font) => change({ font })}
              />
            </Row>
            <Row label="信息密度">
              <Segmented<Density>
                value={prefs.density}
                options={["comfortable", "compact"]}
                labels={DENSITY_NAMES}
                onPick={(density) => change({ density })}
              />
            </Row>
          </Card>

          <Card
            id={SECTION_DOM.ai}
            icon={Bot}
            title="AI"
            desc="模型接入——改完即生效"
            footnote={ai !== null && ai.overridden ? `当前模型 ${ai.model}` : undefined}
          >
            {readFailed ? (
              // 读失败优先于一切（评审 M：否则会拿上一次的旧表单冒充成功）
              <Row label={<span className="text-danger">读不到当前设置（后端在跑吗？）</span>} />
            ) : ai === null ? (
              <Row label={<span className="text-ink-muted">读取中…</span>}>
                <Loader2 size={13} className="animate-spin text-ink-muted" />
              </Row>
            ) : (
              <>
                <Row label="Base URL" description="去服务商官方文档复制填写">
                  <input
                    className="input w-[18rem] max-w-full"
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    onBlur={saveNow}
                    placeholder="https://api.deepseek.com"
                  />
                </Row>
                <Row label="模型" description="服务商官方文档里的模型名">
                  <input
                    className="input w-[18rem] max-w-full"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    onBlur={saveNow}
                    placeholder="deepseek-chat"
                  />
                </Row>
                <Row label="API Key" description="服务商给的密钥；已配置过则留空">
                  <input
                    className="input w-[18rem] max-w-full"
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    onBlur={saveNow}
                    placeholder={ai.apiKeyMasked ?? "未配置"}
                  />
                </Row>
                <Row label="连接测试" description="发一条最小请求实测通断与延迟">
                  <div className="flex items-center gap-2">
                    <button className="btn" disabled={busy !== "none"} onClick={runTest}>
                      {busy === "test" ? "测试中…" : "测试连接"}
                    </button>
                    {ai.overridden && (
                      <button className="btn" disabled={busy !== "none"} onClick={runClear}>
                        清除配置
                      </button>
                    )}
                  </div>
                </Row>
                {/* 状态槽：有测试结果/保存反馈才出现（无则不渲染——用户走查 2026-10-03 修空行）。
                    children 仅在真有 testResult 时给（`{cond && …}` 会传 false，不算内容）。 */}
                <StatusSlot
                  statuses={statuses}
                  {...(testResult === null
                    ? {}
                    : {
                        children:
                          testResult.ok === true ? (
                            <p className="text-accent">通（{testResult.latencyMs ?? "?"} ms）</p>
                          ) : (
                            <p className="text-danger">不通：{testResult.error ?? "未知原因"}</p>
                          ),
                      })}
                />
              </>
            )}
          </Card>

          {/* 收取规则（D-107）：用户亲手写下「不要」——注入 agent0 提示词作最高优先硬闸。
              一份字段同时管事项/通知/存疑库；用户自由文本原样进提示词，系统不解析结构。 */}
          <Card
            id={SECTION_DOM.rules}
            title="收取规则"
            icon={FilterIcon}
            desc="指定不希望收取的内容——点名提及的会被直接拒收，其余照常判断"
          >
            {rulesFailed ? (
              <Row label={<span className="text-danger">读不到当前规则（后端在跑吗？）</span>} />
            ) : (
              /* stacked Row：左上是标题+副标题、下方全宽大文本框——与其他设置项同一套
                 px-4/py-2.5 内距与 border 节奏；不再自己套 div 造成「文字贴框线」。 */
              <Row
                stacked
                label="拒收规则"
                description="用日常语言描述不希望收取的内容，一行一条。失焦即生效——下一条新消息便按此判断。仅拒你点名提及的，其余照常处理；被拒的内容仍会在流水中留痕。"
              >
                <textarea
                  className="textarea min-h-40"
                  value={rules}
                  placeholder={
                    "例如：\n· 拼多多砍一刀、集赞、投票拉票一类链接\n· 群内灌水、问候图片、无实质内容的转发\n· 「以学校通知为准」这类没有实质信息的表述"
                  }
                  onChange={(e) => {
                    setRules(e.target.value);
                    setRulesDirty(true);
                  }}
                  onBlur={saveRules}
                />
                <StatusSlot statuses={statuses} />
              </Row>
            )}
          </Card>

          <Card
            id={SECTION_DOM.data}
            icon={Database}
            title="数据"
            desc="你的账户独立数据库——拷贝即备份"
          >
            <Row
              label="数据文件"
              description="你的账户库（data/users/<uid>.db），点右侧在线导出（不影响使用）"
            >
              <a className="btn" href="/api/backup">
                下载备份
              </a>
            </Row>
          </Card>

          <Card
            id={SECTION_DOM.sources}
            icon={Rss}
            title="信源"
            desc="配置与状态——改完即生效"
            bare
            footnote="对话输入始终可用——把信息发给前台即录入。"
          >
            <SourcesSection />
          </Card>
        </div>
      </div>
    </div>
  );
}

/** 表单 → 请求体（Key 留空 = 沿用现值）。模块级纯函数（simplify 评审：useCallback 版被迫进依赖，零收益）。 */
function toBody(form: { baseUrl: string; model: string; apiKey: string }): AiSettings {
  return {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    ...(form.apiKey !== "" ? { apiKey: form.apiKey } : {}),
  };
}
