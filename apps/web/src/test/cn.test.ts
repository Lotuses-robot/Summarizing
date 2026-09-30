import { describe, expect, it } from "vitest";
import { cn } from "../lib/cn";

describe("cn（Tailwind 类合并）", () => {
  it("冲突类后写者胜", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("falsy 条件类被丢弃", () => {
    const hidden = false;
    expect(cn("px-2", hidden && "px-8", "py-1")).toBe("px-2 py-1");
  });

  it("不冲突的类全部保留", () => {
    expect(cn("flex", "items-center", "gap-1")).toBe("flex items-center gap-1");
  });
});
