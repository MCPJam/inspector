import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { assistantParts } from "./factories";

const reasoning = (text: string) =>
  assistantParts([{ type: "reasoning", text, state: "done" }]);

describe("reasoning display modes", () => {
  it("renders reasoning text inline by default", () => {
    const { container } = render(
      <ReadOnlyTranscript messages={[reasoning("thinking step")]} />,
    );
    expect(container.textContent).toContain("thinking step");
    // Inline mode has no collapse toggle.
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("hides reasoning entirely with reasoningDisplayMode='hidden'", () => {
    const { container } = render(
      <ReadOnlyTranscript
        messages={[reasoning("secret thoughts")]}
        reasoningDisplayMode="hidden"
      />,
    );
    expect(container.textContent).not.toContain("secret thoughts");
  });

  it("renders a collapsed toggle with reasoningDisplayMode='collapsed'", () => {
    const { container } = render(
      <ReadOnlyTranscript
        messages={[reasoning("collapsed thoughts")]}
        reasoningDisplayMode="collapsed"
      />,
    );
    const toggle = container.querySelector("button[aria-expanded='false']");
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("Reasoning");
  });
});
