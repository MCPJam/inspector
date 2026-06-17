import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VSCodeShimmerIndicator } from "../vscode-shimmer";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("VSCodeShimmerIndicator", () => {
  it("renders the shimmering progress-step text node", () => {
    const { getByTestId } = render(<VSCodeShimmerIndicator />);
    const node = getByTestId("loading-indicator-vscode-shimmer");
    expect(node).toBeTruthy();
    expect(node.textContent).toBe("Working");
  });

  it("binds the vscode-shimmer animation hook via class", () => {
    // Animation values resolve from CSS in `index.css` — assert the class
    // wiring so a refactor can't silently drop the keyframe binding. The
    // actual keyframe (`vscode-shimmer 2s linear infinite`) is verified in
    // the preview, not here.
    const { getByTestId } = render(<VSCodeShimmerIndicator />);
    expect(
      getByTestId("loading-indicator-vscode-shimmer").classList.contains(
        "vscode-shimmer-indicator"
      )
    ).toBe(true);
  });

  it("forwards className to the outer wrapper", () => {
    const { container } = render(
      <VSCodeShimmerIndicator className="custom-test-class" />
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.classList.contains("custom-test-class")).toBe(true);
  });

  it("declares an aria-live region so the thinking state is announced", () => {
    const { container } = render(<VSCodeShimmerIndicator />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    // The visible verb is masked to transparent by the shimmer, so it's
    // also mirrored sr-only for screen readers.
    expect(container.textContent).toContain("Working");
  });

  it("defaults to data-theme='dark' when no chatbox host theme is mounted", () => {
    // Matches the inspector's "no chatbox context" fallback (see
    // CopilotMessageHeader). Dark is the verbatim #8C8C8C/#FFF capture;
    // light mode overrides via the [data-theme="light"] rule.
    const { getByTestId } = render(<VSCodeShimmerIndicator />);
    expect(getByTestId("loading-indicator-vscode-shimmer").dataset.theme).toBe(
      "dark"
    );
  });

  it("switches to data-theme='light' under a light chatbox host theme", () => {
    const { getByTestId } = render(
      <ChatboxHostThemeProvider value="light">
        <VSCodeShimmerIndicator />
      </ChatboxHostThemeProvider>
    );
    expect(getByTestId("loading-indicator-vscode-shimmer").dataset.theme).toBe(
      "light"
    );
  });
});
