// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initAppearance, loadAppearance, resolveDark, updateAppearance } from "../lib/appearance";
import "@testing-library/jest-dom/vitest";

describe("appearance（外观偏好，05§五）", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("resolveDark：暗/亮直选，系统档跟随系统", () => {
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });

  it("updateAppearance：立即写 <html> 属性并持久化，load 回读一致", () => {
    const next = updateAppearance({
      theme: "dark",
      palette: "rose",
      font: "serif",
      density: "compact",
    });
    expect(next.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-palette")).toBe("rose");
    expect(document.documentElement.getAttribute("data-font")).toBe("serif");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");

    // 持久化：重载偏好应一致（模拟下次启动）
    expect(loadAppearance()).toEqual(next);
  });

  it("默认 teal 不写 data-palette 属性（index.css :root 即青）", () => {
    updateAppearance({ palette: "teal", theme: "light", font: "system", density: "comfortable" });
    expect(document.documentElement.hasAttribute("data-palette")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("initAppearance：系统亮色档不挂 dark class；坏值安全回默认", () => {
    // matchMedia 在 happy-dom 里默认非暗色
    vi.stubGlobal("matchMedia", window.matchMedia.bind(window));
    window.localStorage.setItem("summarizing.theme", "不是合法值");
    initAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    vi.unstubAllGlobals();
  });
});
