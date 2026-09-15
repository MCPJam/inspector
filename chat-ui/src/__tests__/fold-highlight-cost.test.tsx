import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
import { assistantParts, toolPart } from "./factories";

/**
 * A collapsed `FoldedBlock` keeps its children MOUNTED — clipped, `aria-hidden`
 * and `inert`, not unmounted — so a syntax-highlighted payload would build one
 * React element per token for content nobody can read. The fold threshold is
 * 800 characters and the highlight cap is 100k, so that gap covers most real
 * tool results.
 *
 * This is the one change in the parity work whose entire justification is a
 * runtime cost, so it needs an assertion that observes it end to end. The leaf
 * prop (`JsonView highlight={false}`) is pinned in `json-view.test.tsx`; what
 * is pinned HERE is the chain that makes it real — that `FoldedBlock` calls a
 * function child with the open state, and that `ToolCallPart` threads it into
 * `JsonView`. Break either link and the token tree comes back silently.
 */
describe("folded payloads do not pay for highlighting", () => {
  const messages = [
    assistantParts([
      toolPart({
        toolName: "dump",
        output: {
          rows: Array.from({ length: 200 }, (_, i) => ({
            id: `row_${i}`,
            value: i,
          })),
        },
      }),
    ]),
  ];

  it("colours a large payload only once it is opened", () => {
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    const toggle = screen.getByRole("button", { name: /Output/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    const preview = screen.getByTestId("folded-block-preview");
    // The payload is all there — collapsing is visual, and losslessness does
    // not depend on the fold state.
    expect(preview.textContent).toContain('"row_0"');
    // ...but uncoloured, which is the cost this avoids.
    expect(preview.querySelector(".json-key")).toBeNull();
    expect(preview.querySelector("span")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("folded-block-preview")).toBeNull();
    expect(container.querySelector(".json-key")).not.toBeNull();
    expect(container.querySelector(".json-number")).not.toBeNull();
  });

  it("still colours a payload small enough not to fold", () => {
    // No toggle, nothing hidden, so there is nothing to save — and a reader
    // looking at two surfaces should not be able to tell which renderer drew
    // this one.
    const { container } = render(
      <ReadOnlyTranscript
        messages={[
          assistantParts([toolPart({ toolName: "ping", output: { ok: 1 } })]),
        ]}
      />
    );

    expect(container.querySelector(".mcpjam-chat-fold-toggle")).toBeNull();
    expect(container.querySelector(".json-key")).not.toBeNull();
  });
});
