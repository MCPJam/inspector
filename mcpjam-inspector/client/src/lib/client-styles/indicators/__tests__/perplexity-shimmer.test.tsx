import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PerplexityShimmerIndicator } from "../perplexity-shimmer";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("PerplexityShimmerIndicator", () => {
  it("renders the spinning mark and shimmering 'Thinking' label", () => {
    const { getByTestId } = render(<PerplexityShimmerIndicator />);

    const wrapper = getByTestId("loading-indicator-perplexity");
    expect(wrapper.textContent).toContain("Thinking");

    // The brand mark spins via `.perplexity-spin` (keyframes in index.css).
    const logo = getByTestId("loading-indicator-perplexity-logo");
    expect(logo.tagName.toLowerCase()).toBe("img");
    expect(logo).toHaveClass("perplexity-spin");
    // Decorative — the verb is announced via aria-live + sr-only, so the mark
    // must not be read out.
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveAttribute("alt", "");
  });

  it("binds the perplexity-shimmer-text animation hook via class", () => {
    // Animation resolves from CSS in `index.css` — assert the class wiring so
    // a refactor can't silently drop the keyframe binding.
    const { getByTestId } = render(<PerplexityShimmerIndicator />);
    expect(
      getByTestId("loading-indicator-perplexity-label").classList.contains(
        "perplexity-shimmer-text"
      )
    ).toBe(true);
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <PerplexityShimmerIndicator className="custom-test-class" />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region and mirrors the verb sr-only", () => {
    const { container } = render(<PerplexityShimmerIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The visible label is masked transparent by the shimmer, so the verb is
    // also mirrored sr-only for screen readers.
    expect(container.textContent).toContain("Thinking");
  });

  it("defaults the label to data-theme='dark' when no chatbox host theme is mounted", () => {
    const { getByTestId } = render(<PerplexityShimmerIndicator />);
    expect(
      getByTestId("loading-indicator-perplexity-label").dataset.theme
    ).toBe("dark");
  });

  it("switches the label to data-theme='light' under a light chatbox host theme", () => {
    const { getByTestId } = render(
      <ChatboxHostThemeProvider value="light">
        <PerplexityShimmerIndicator />
      </ChatboxHostThemeProvider>
    );
    expect(
      getByTestId("loading-indicator-perplexity-label").dataset.theme
    ).toBe("light");
  });
});
