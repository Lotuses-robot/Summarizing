import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  Database,
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
type SectionId = "appearance" | "ai" | "data" | "sources";
type SectionMeta = { id: SectionId; label: string; icon: LucideIcon };
const SECTIONS: SectionMeta[] = [
  { id: "appearance", label: "外观", icon: PaletteIcon },
  { id: "ai", label: "AI", icon: Bot },
  { id: "data", label: "数据", icon: Database },
  { id: "sources", label: "信源", icon: Rss },
];

/** 设置弹层（05§五 / D-81）：居中，Esc/点外关。外观进 localStorage、AI 进 app_settings、
 *  数据区只读+备份下载、信源区真界面。系统策略不在这里——没有旋钮。
 *  交互总则（走查修订③）：**改完即生效**——下拉/色板/开关点一下即存，输入框失焦即存，
 *  卡尾状态行一闪「已保存」；失败常驻红字（不静默）。整页无「保存」按钮。
 *  ⚠️ 关闭前先 blur（评审 H1）：Esc 不产生焦点转移，「失焦即存」必须在卸载前落一次。 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prefs, setPrefs] = useState<AppearancePrefs>(loadAppearance);
  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [form, setForm] = useState({ baseUrl: "", model: "", apiKey: "" });
  const [busy, setBusy] = useState<"none" | "test" | "clear">("none");
  const [readFailed, setReadFailed] = useState(false);
  const { statuses, flash, sticky } = useStatus();
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("appearance");
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /** 关闭（三条路径共用）：先 blur 触发「失焦即存」的提交，再关——Esc 否则会静默丢未失焦的输入。 */
  const closeWithFlush = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    onCloseRef.current();
  }, []);

  /** 点左侧分类：高亮 + 右侧滚动到对应分区。 */
  const goToSection = (id: SectionId) => {
    setActiveSection(id);
    document
      .getElementById(`settings-${id}`)
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
    return () => offEsc();
  }, [open, closeWithFlush]);

  /** 改外观项：立即应用 + 持久化（lib/appearance 单一入口）——外观即点即生效，无需状态提示。 */
  const change = (patch: Partial<AppearancePrefs>) => setPrefs(updateAppearance(patch));

  /** AI 设置视图回填表单（打开拉取/保存成功共用——回填策略改一处生效）。 */
  const applyAiView = (v: AiSettingsView) => {
    setAi(v);
    setForm({ baseUrl: v.baseUrl, model: v.model, apiKey: "" });
  };

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

  /** 清除覆盖：回 .env。 */
  const runClear = () => {
    if (ai === null || busy !== "none") return;
    setBusy("clear");
    api
      .clearAiSettings()
      .then((v) => {
        applyAiView(v);
        flash("save", "已清除覆盖，回 .env 配置");
      })
      .catch((err: unknown) => sticky("clear", `清除失败：${errText(err)}`))
      .finally(() => setBusy("none"));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={closeWithFlush}>
      <div
        className="mx-auto mt-[7vh] flex h-[min(620px,84vh)] w-[min(860px,94vw)] overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
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

        <div className="flex-1 space-y-7 overflow-y-auto px-6 py-5">
          <Card
            id="settings-appearance"
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
            id="settings-ai"
            icon={Bot}
            title="AI"
            desc="模型接入——改完即生效"
            footnote={
              ai !== null ? (
                <>
                  ⚠ Key 以明文存在本机 SQLite（单机自部署，知情选择）；当前生效：
                  {ai.overridden ? "设置覆盖" : ".env"} · 模型 {ai.model}
                </>
              ) : undefined
            }
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
                <Row label="Base URL" description="OpenAI 兼容，须带 /v1">
                  <input
                    className="input w-[18rem] max-w-full"
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    onBlur={saveNow}
                    placeholder="http://127.0.0.1:8317/v1"
                  />
                </Row>
                <Row label="模型">
                  <input
                    className="input w-[18rem] max-w-full"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    onBlur={saveNow}
                    placeholder="deepseek-v4.1-flash"
                  />
                </Row>
                <Row
                  label="API Key"
                  description={ai.overridden ? "留空 = 沿用现值" : "留空 = 沿用 .env"}
                >
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
                        清除覆盖（回 .env）
                      </button>
                    )}
                  </div>
                </Row>
                {/* 状态槽定高常驻（评审 H：条件渲染会 33px 跳版）——测试结果两行当 children 塞入 */}
                <StatusSlot statuses={statuses}>
                  {testResult !== null && testResult.ok === true && (
                    <p className="text-accent">通（{testResult.latencyMs ?? "?"} ms）</p>
                  )}
                  {testResult !== null && testResult.ok === false && (
                    <p className="text-danger">不通：{testResult.error ?? "未知原因"}</p>
                  )}
                </StatusSlot>
              </>
            )}
          </Card>

          <Card id="settings-data" icon={Database} title="数据" desc="单文件 SQLite——拷走即备份">
            <Row
              label="数据文件"
              description="仓库根 data/summarizing.db，点右侧在线导出（不影响使用）"
            >
              <a className="btn" href="/api/backup">
                下载备份
              </a>
            </Row>
          </Card>

          <Card
            id="settings-sources"
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
