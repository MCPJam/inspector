import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CopilotMessageHeader } from "../copilot-message-header";
import { ChatboxHostThemeProvider } from "@/contexts/chatbox-client-style-context";

describe("CopilotMessageHeader", () => {
  it("renders the avatar (with monochromatic mascot SVG) and the 'Copilot' name", () => {
    const { getByTestId } = render(<CopilotMessageHeader />);
    expect(getByTestId("copilot-message-header")).toBeTruthy();
    const avatar = getByTestId("copilot-message-header-avatar");
    const svg = avatar.querySelector("svg");
    expect(svg).not.toBeNull();
    // Mascot uses currentColor (not the brand gradient) so it blends with
    // the surrounding text — the picker pill uses the colored PNG, but
    // the thread header is monochromatic.
    expect(svg?.querySelector("path")?.getAttribute("fill")).toBe(
      "currentColor",
    );
    expect(getByTestId("copilot-message-header-name").textContent).toBe(
      "Copilot",
    );
  });

  it("renders an sr-only 'Copilot said:' heading for a11y", () => {
    const { container } = render(<CopilotMessageHeader />);
    const heading = container.querySelector("h6");
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe("Copilot said:");
    // The heading is visually hidden (clip-path/offscreen) but stays in the
    // a11y tree — `position: absolute` + `width: 1px` is the standard SR-only
    // pattern we mirror from the real Copilot markup.
    expect(heading?.style.position).toBe("absolute");
    expect(heading?.style.width).toBe("1px");
  });

  it("applies the Copilot brand typography on the name", () => {
    const { getByTestId } = render(<CopilotMessageHeader />);
    const name = getByTestId("copilot-message-header-name");
    // Semibold is the only weight that differs between the container
    // (inherits regular 400) and the name (600). Locking the rule here
    // catches accidental token drift.
    expect(name.style.fontWeight).toBe("600");
    expect(name.style.whiteSpace).toBe("nowrap");
  });

  it("uses the Fluent dark foreground (#d6d6d6) by default", () => {
    // No chatbox host context → fallback to dark, matching the rest of
    // the chat shell's "no host" fallback behavior.
    const { getByTestId } = render(<CopilotMessageHeader />);
    const root = getByTestId("copilot-message-header");
    expect(root.style.color).toBe("rgb(214, 214, 214)");
    expect(root.dataset.theme).toBe("dark");
  });

  it("switches to the Fluent light foreground (#424242) under a light host theme", () => {
    const { getByTestId } = render(
      <ChatboxHostThemeProvider value="light">
        <CopilotMessageHeader />
      </ChatboxHostThemeProvider>,
    );
    const root = getByTestId("copilot-message-header");
    expect(root.style.color).toBe("rgb(66, 66, 66)");
    expect(root.dataset.theme).toBe("light");
  });
});
