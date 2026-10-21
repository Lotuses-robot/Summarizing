// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaText } from "../components/board/MediaText";
import "@testing-library/jest-dom/vitest";

// 009 刀 2 前端：占位 → 图片渲染；未命中按来源回退（本地 →「图片已过期」；外部 → 原链接）。

afterEach(() => {
  cleanup();
});

/** 一份 media 映射（本地命中）。 */
function mediaMap() {
  return {
    "/api/media/abc123": {
      id: "abc123",
      mime: "image/jpeg",
      sizeBytes: 1000,
      expiresAt: "2026-11-01T00:00:00",
    },
  };
}

describe("MediaText", () => {
  it("无占位 → 原样渲染纯文本", () => {
    render(<MediaText text="今天交作业" />);
    expect(screen.getByText("今天交作业")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("本地占位命中 → 渲染 <img>，src = 占位 URL", () => {
    render(<MediaText text="见 [图片](/api/media/abc123) 这张" mediaMap={mediaMap()} />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/media/abc123");
    // 上下文文本仍在（占位被图替换，但不是整段消失）
    expect(screen.getByText(/见/)).toBeInTheDocument();
    expect(screen.getByText(/这张/)).toBeInTheDocument();
  });

  it("同一张图重复占位只渲染一次（去重后逐个替换）", () => {
    render(
      <MediaText
        text="[图片](/api/media/abc123) 和 [图片](/api/media/abc123)"
        mediaMap={mediaMap()}
      />,
    );
    expect(document.querySelectorAll("img")).toHaveLength(2); // 两处都出图（不是去重在渲染层）
  });

  it("本地占位**未命中**（过期/未缓存）→「图片已过期」，不静默", () => {
    render(<MediaText text="[图片](/api/media/gone.jpg)" mediaMap={{}} />);
    expect(screen.getByText("［图片已过期］")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("外部 URL 未命中 → 回退原链接（可点）", () => {
    render(<MediaText text="[图片](https://qq.example/x.jpg)" mediaMap={{}} />);
    const link = screen.getByRole("link", { name: "［图片链接］" });
    expect(link).toHaveAttribute("href", "https://qq.example/x.jpg");
    expect(document.querySelector("img")).toBeNull();
  });

  it("图片加载失败（onError）→ 本地占位转「图片已过期」", () => {
    render(<MediaText text="[图片](/api/media/abc123)" mediaMap={mediaMap()} />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByText("［图片已过期］")).toBeInTheDocument();
  });

  it("无 mediaMap（对话气泡）：本地占位直接出图——浏览器自己带 cookie 请求", () => {
    // 对话回填不带 detail.media；但登录态下 <img src="/api/media/..."> 会自动带 cookie
    render(<MediaText text="[图片](/api/media/abc123)" />);
    expect(document.querySelector("img")?.getAttribute("src")).toBe("/api/media/abc123");
  });

  it("畸形占位（无 URL / 带空格）→ 不渲染图、不崩", () => {
    render(<MediaText text="[图片] 和 [图片](https://a/b c.jpg) 结束" />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/\[图片\]/)).toBeInTheDocument();
  });
});

describe("MediaText：缓存图必须读本地副本（009 修复）", () => {
  /** 信源图命中：map 的键是原链接，值指向本地 sha。 */
  const originKeyed = {
    "https://qq.example/x.jpg": {
      id: "abc123",
      mime: "image/jpeg",
      sizeBytes: 1000,
      expiresAt: "2026-11-01T00:00:00",
    },
  };

  it("原链接已过期也没关系——src 读 /api/media/<id>，不是占位里的原链接", () => {
    render(<MediaText text="[图片](https://qq.example/x.jpg)" mediaMap={originKeyed} />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/media/abc123"); // 关键：不是 qq 的地址
  });

  it("占位写成带扩展名/绝对地址时按归一键命中（不会误判成「已过期」）", () => {
    render(<MediaText text="[图片](/api/media/abc123.jpg)" mediaMap={mediaMap()} />);
    expect(document.querySelector("img")?.getAttribute("src")).toBe("/api/media/abc123");
    cleanup();
    render(
      <MediaText text="[图片](https://sum.lotuses.cn/api/media/abc123)" mediaMap={mediaMap()} />,
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe("/api/media/abc123");
  });
});
