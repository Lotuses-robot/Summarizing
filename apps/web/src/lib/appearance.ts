// 界面偏好（05§五）：「用户偏好进设置，系统策略进代码」。
// 全部存 localStorage 平键（值只有 "1"/"0"/短字符串，零解析风险）；
// 主题应用 = 写 <html> 属性——选择器与 index.css 的定义一字不差（错一处暗色/色板静默失效）。

const CHAT_OPEN_KEY = "summarizing.chatOpen";
const FOLD_KEY_PREFIX = "summarizing.fold.";
const THEME_KEY = "summarizing.theme";
const PALETTE_KEY = "summarizing.palette";
const FONT_KEY = "summarizing.font";
const DENSITY_KEY = "summarizing.density";

// 段默认折叠：已完成/已归档（D-80）；其余段默认展开
const DEFAULT_FOLDED: readonly string[] = ["done", "archived"];

export type ThemeMode = "light" | "dark" | "system";
export type Palette = "teal" | "blue" | "green" | "purple" | "orange" | "rose";
export type FontChoice = "system" | "round" | "serif";
export type Density = "comfortable" | "compact";

export const PALETTES: readonly Palette[] = [
  "teal",
  "blue",
  "green",
  "purple",
  "orange",
  "rose",
] as const;
const FONTS: readonly FontChoice[] = ["system", "round", "serif"];

export interface AppearancePrefs {
  theme: ThemeMode;
  palette: Palette;
  font: FontChoice;
  density: Density;
}

/** 读一个偏好键；存储被禁（隐私模式等）返回 null → 调用方用默认。 */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // 存储被禁（隐私模式等）→ 用默认
  }
}

/** 写一个偏好键；写不进就放弃——偏好非数据，丢了不影响功能。 */
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 静默放弃是刻意的：这不是数据，是偏好
  }
}

/** 读对话面板开合记忆；无记忆默认开（首启可发现性）。 */
export function loadChatOpen(): boolean {
  return read(CHAT_OPEN_KEY) !== "0";
}

/** 记住对话面板开合。 */
export function saveChatOpen(open: boolean): void {
  write(CHAT_OPEN_KEY, open ? "1" : "0");
}

/** 读段折叠记忆（无记忆用默认：已完成/已归档折叠，D-80）。 */
export function loadSectionFold(section: string): boolean {
  const v = read(FOLD_KEY_PREFIX + section);
  if (v !== null) return v === "1";
  return DEFAULT_FOLDED.includes(section);
}

/** 记住段折叠状态。 */
export function saveSectionFold(section: string, folded: boolean): void {
  write(FOLD_KEY_PREFIX + section, folded ? "1" : "0");
}

/** 载入全部外观偏好（无记忆给默认：系统主题 / 青 / 系统字体 / 舒适）。 */
export function loadAppearance(): AppearancePrefs {
  const theme = read(THEME_KEY);
  const palette = read(PALETTE_KEY);
  const font = read(FONT_KEY);
  return {
    theme: theme === "light" || theme === "dark" ? theme : "system",
    palette: PALETTES.find((p) => p === palette) ?? "teal",
    font: FONTS.find((f) => f === font) ?? "system",
    density: read(DENSITY_KEY) === "compact" ? "compact" : "comfortable",
  };
}

/** 纯决策：主题模式 + 系统当前暗与否 → 是否用暗色（独立导出以便直接测试）。 */
export function resolveDark(mode: ThemeMode, systemIsDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemIsDark);
}

/** 应用外观到 <html>（index.css 的选择器与此一字不差）。供 updateAppearance/initAppearance 内部使用。 */
function applyAppearance(p: AppearancePrefs): void {
  const root = document.documentElement;
  const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", resolveDark(p.theme, systemIsDark));
  if (p.palette === "teal") root.removeAttribute("data-palette");
  else root.setAttribute("data-palette", p.palette);
  if (p.font === "system") root.removeAttribute("data-font");
  else root.setAttribute("data-font", p.font);
  if (p.density === "comfortable") root.removeAttribute("data-density");
  else root.setAttribute("data-density", "compact");
}

/** 改任一外观项：持久化 + 立即应用，返回合并后的完整偏好（设置弹层的唯一入口）。 */
export function updateAppearance(patch: Partial<AppearancePrefs>): AppearancePrefs {
  const next = { ...loadAppearance(), ...patch };
  write(THEME_KEY, next.theme);
  write(PALETTE_KEY, next.palette);
  write(FONT_KEY, next.font);
  write(DENSITY_KEY, next.density);
  applyAppearance(next);
  return next;
}

/** 启动时应用一次 + 「系统」档跟随系统明暗切换（main.tsx 调用）。 */
export function initAppearance(): void {
  applyAppearance(loadAppearance());
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => applyAppearance(loadAppearance()));
}
