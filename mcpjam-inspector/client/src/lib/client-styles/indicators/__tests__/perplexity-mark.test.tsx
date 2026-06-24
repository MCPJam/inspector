import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PerplexityMarkIndicator } from "../perplexity-mark";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("PerplexityMarkIndicator", () => {
  it("renders the scrolling Perplexity-mark sprite strip", () => {
    const { getByTestId } = render(<PerplexityMarkIndicator />);

    const wrapper = getByTestId("loading-indicator-perplexity");
    // The verb is announced via the sr-only span (the strip is decorative).
    expect(wrapper.textContent).toContain("Thinking");

    const mark = getByTestId("loading-indicator-perplexity-mark");
    const svg = mark.querySelector("svg");
    expect(svg).not.toBeNull();
    // Captured verbatim: a 1248×24 strip of ~52 mark frames.
    expect(svg).toHaveAttribute("viewBox", "0 0 1248 24");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("fill", "none");
    // The conveyor animation resolves from `.perplexity-indicator__strip` in
    // index.css — assert the class wiring so a refactor can't silently drop
    // the keyframe binding.
    expect(svg).toHaveClass("perplexity-indicator__strip");
    // The window clips the overflowing strip down to a single mark.
    expect(mark.classList.contains("overflow-hidden")).toBe(true);
    expect(svg!.querySelector("path")).not.toBeNull();
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <PerplexityMarkIndicator className="custom-test-class" />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region and mirrors the verb sr-only", () => {
    const { container } = render(<PerplexityMarkIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    expect(container.textContent).toContain("Thinking");
  });

  it("defaults to data-theme='dark' when no chatbox host theme is mounted", () => {
    const { getByTestId } = render(<PerplexityMarkIndicator />);
    expect(getByTestId("loading-indicator-perplexity").dataset.theme).toBe(
      "dark"
    );
  });

  it("switches to data-theme='light' under a light chatbox host theme", () => {
    const { getByTestId } = render(
      <ChatboxHostThemeProvider value="light">
        <PerplexityMarkIndicator />
      </ChatboxHostThemeProvider>
    );
    expect(getByTestId("loading-indicator-perplexity").dataset.theme).toBe(
      "light"
    );
  });
});
