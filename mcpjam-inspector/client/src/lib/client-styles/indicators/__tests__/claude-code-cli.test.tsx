import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClaudeCodeCliIndicator } from "../claude-code-cli";

describe("ClaudeCodeCliIndicator", () => {
  it("renders the CLI spinner node with the 'Thinking' label", () => {
    const { getByTestId } = render(<ClaudeCodeCliIndicator />);
    const node = getByTestId("loading-indicator-claude-code-cli");
    expect(node).toBeTruthy();
    expect(node.textContent).toContain("Thinking");
  });

  it("binds the braille-spinner keyframe via class", () => {
    // Spinner frames resolve from `@keyframes claude-code-cli-spinner` in
    // `index.css`, driven off `.claude-code-cli-indicator__spinner::before`.
    // Assert the class wiring so a refactor can't silently drop it.
    const { container } = render(<ClaudeCodeCliIndicator />);
    expect(
      container.querySelector(".claude-code-cli-indicator__spinner"),
    ).not.toBeNull();
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <ClaudeCodeCliIndicator className="custom-test-class" />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region so the thinking state is announced", () => {
    const { container } = render(<ClaudeCodeCliIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The spinner glyph is aria-hidden, so the sr-only "Thinking" carries
    // the state for assistive tech.
    expect(container.querySelector(".sr-only")?.textContent).toBe("Thinking");
  });
});
