import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentCoreShineIndicator } from "../agentcore-shine";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("AgentCoreShineIndicator", () => {
  it("renders the shimmering 'Thinking' text node", () => {
    const { getByTestId } = render(<AgentCoreShineIndicator />);
    const node = getByTestId("loading-indicator-agentcore-shine");
    expect(node).toBeTruthy();
    expect(node.textContent).toBe("Thinking");
  });

  it("binds the agentcore-shine animation hook via class", () => {
    // Animation values resolve from CSS in `index.css` — `.agentcore-shine-indicator`
    // shares Cursor's `.cursor-shine-indicator` rule body via a multi-selector
    // so the keyframe binding is the same. Assert the class wiring so a
    // refactor can't silently drop it.
    const { getByTestId } = render(<AgentCoreShineIndicator />);
    expect(
      getByTestId("loading-indicator-agentcore-shine").classList.contains(
        "agentcore-shine-indicator"
      )
    ).toBe(true);
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <AgentCoreShineIndicator className="custom-test-class" />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region so the thinking state is announced", () => {
    const { container } = render(<AgentCoreShineIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The visible "Thinking" verb is also mirrored sr-only so the screen
    // reader hears it even if the visible run-length glyph is masked to
    // transparent by the shimmer gradient.
    expect(container.textContent).toContain("Thinking");
  });

  it("defaults to data-theme='dark' when no chatbox host theme is mounted", () => {
    // Matches the inspector's "no chatbox context" fallback (see
    // CopilotMessageHeader / CursorShineIndicator). The dark base is the
    // verbatim #E4E4E4 capture shared with Cursor; light mode overrides
    // via the [data-theme="light"] rule.
    const { getByTestId } = render(<AgentCoreShineIndicator />);
    expect(getByTestId("loading-indicator-agentcore-shine").dataset.theme).toBe(
      "dark"
    );
  });

  it("switches to data-theme='light' under a light chatbox host theme", () => {
    const { getByTestId } = render(
      <ChatboxHostThemeProvider value="light">
        <AgentCoreShineIndicator />
      </ChatboxHostThemeProvider>
    );
    expect(getByTestId("loading-indicator-agentcore-shine").dataset.theme).toBe(
      "light"
    );
  });
});
