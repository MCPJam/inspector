import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CursorShineIndicator } from "../cursor-shine";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("CursorShineIndicator", () => {
  it("renders the shimmering 'Planning next moves' text node", () => {
    const { getByTestId } = render(<CursorShineIndicator />);
    const node = getByTestId("loading-indicator-cursor-shine");
    expect(node).toBeTruthy();
    expect(node.textContent).toBe("Planning next moves");
  });

  it("binds the cursor-shine animation hook via class", () => {
    // Animation values resolve from CSS in `index.css` — assert the class
    // wiring so a refactor can't silently drop the keyframe binding. The
    // actual keyframe (`cursor-shine 2s linear infinite`) is verified in
    // the preview, not here.
    const { getByTestId } = render(<CursorShineIndicator />);
    expect(
      getByTestId("loading-indicator-cursor-shine").classList.contains(
        "cursor-shine-indicator",
      ),
    ).toBe(true);
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <CursorShineIndicator className="custom-test-class" />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region so the thinking state is announced", () => {
    const { container } = render(<CursorShineIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The visible "Planning next moves" verb is also mirrored sr-only so
    // the screen-reader hears it even if the visible run-length glyph is
    // masked to transparent.
    expect(container.textContent).toContain("Planning next moves");
  });

  it("defaults to data-theme='dark' when no chatbox host theme is mounted", () => {
    // Matches the inspector's "no chatbox context" fallback (see
    // CopilotMessageHeader). The dark base is the verbatim #E4E4E4
    // capture; light mode overrides via the [data-theme="light"] rule.
    const { getByTestId } = render(<CursorShineIndicator />);
    expect(
      getByTestId("loading-indicator-cursor-shine").dataset.theme,
    ).toBe("dark");
  });

  it("switches to data-theme='light' under a light chatbox host theme", () => {
    const { getByTestId } = render(
      <ChatboxHostThemeProvider value="light">
        <CursorShineIndicator />
      </ChatboxHostThemeProvider>,
    );
    expect(
      getByTestId("loading-indicator-cursor-shine").dataset.theme,
    ).toBe("light");
  });
});
