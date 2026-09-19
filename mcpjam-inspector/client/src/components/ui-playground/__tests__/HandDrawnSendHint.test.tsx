import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HandDrawnSendHint } from "../HandDrawnSendHint";

describe("HandDrawnSendHint", () => {
  it("renders the arrow inline as JSX, not as raw HTML", () => {
    const { container } = render(<HandDrawnSendHint theme="light" />);
    const path = container.querySelector("svg path");
    // arrow-8 opens on the arrowhead at x=129; arrow-3 started elsewhere.
    expect(path?.getAttribute("d")).toMatch(/^M129\.189/);
    expect(path?.getAttribute("fill")).toBe("currentColor");
  });

  it("renders the hint label", () => {
    render(<HandDrawnSendHint theme="light" />);
    expect(screen.getByTestId("playground-send-nux-hint")).toHaveTextContent(
      "Try this prompt with Excalidraw and compare across clients",
    );
  });
});
