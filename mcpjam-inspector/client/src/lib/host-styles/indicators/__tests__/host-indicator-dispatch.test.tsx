import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HostIndicatorDispatch } from "../host-indicator-dispatch";

describe("HostIndicatorDispatch", () => {
  it("renders 3 dots by default for kind:'dots'", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch def={{ kind: "dots" }} />,
    );
    const wrap = getByTestId("loading-indicator-dispatch-dots");
    expect(wrap.getAttribute("data-dot-count")).toBe("3");
    expect(wrap.children).toHaveLength(3);
  });

  it("renders the configured dot count", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch def={{ kind: "dots", count: 1 }} />,
    );
    const wrap = getByTestId("loading-indicator-dispatch-dots");
    expect(wrap.getAttribute("data-dot-count")).toBe("1");
    expect(wrap.children).toHaveLength(1);
  });

  it("applies the configured dot color", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch def={{ kind: "dots", color: "rgb(0, 128, 255)" }} />,
    );
    const wrap = getByTestId("loading-indicator-dispatch-dots");
    const firstDot = wrap.children[0] as HTMLElement;
    expect(firstDot.style.backgroundColor).toBe("rgb(0, 128, 255)");
  });

  it("staggers dot animation delays", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch def={{ kind: "dots", count: 3 }} />,
    );
    const wrap = getByTestId("loading-indicator-dispatch-dots");
    const dots = Array.from(wrap.children) as HTMLElement[];
    expect(dots[0].style.animationDelay).toBe("0ms");
    expect(dots[1].style.animationDelay).toBe("150ms");
    expect(dots[2].style.animationDelay).toBe("300ms");
  });

  it("renders an image for kind:'image' with pulse animation by default", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch
        def={{ kind: "image", src: "https://example.com/logo.png" }}
      />,
    );
    const img = getByTestId("loading-indicator-dispatch-image") as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.src).toBe("https://example.com/logo.png");
    expect(img.getAttribute("data-animation")).toBe("pulse");
    expect(img.className).toContain("animate-pulse");
  });

  it("applies animate-spin for kind:'image' with animation:'spin'", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch
        def={{ kind: "image", src: "/x.png", animation: "spin" }}
      />,
    );
    const img = getByTestId("loading-indicator-dispatch-image");
    expect(img.className).toContain("animate-spin");
    expect(img.className).not.toContain("animate-pulse");
  });

  it("omits animation utility classes for animation:'none'", () => {
    const { getByTestId } = render(
      <HostIndicatorDispatch
        def={{ kind: "image", src: "/x.png", animation: "none" }}
      />,
    );
    const img = getByTestId("loading-indicator-dispatch-image");
    expect(img.className).not.toContain("animate-spin");
    expect(img.className).not.toContain("animate-pulse");
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <HostIndicatorDispatch
        def={{ kind: "dots" }}
        className="custom-class"
      />,
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain("custom-class");
  });
});
