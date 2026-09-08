import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ReadOnlyTranscript, Transcript } from "../read-only-transcript";
import type { ToolRenderContext } from "../types";
import { assistantParts, toolPart } from "./factories";
import {
  FOLD_CHAR_LIMIT,
  FOLD_LINE_LIMIT,
  countLines,
  shouldFold,
} from "../parts/folded-block";

/**
 * BB-198. A session transcript has to read as a conversation, not as a JSON
 * dump — the two failures behind that were a readable result the renderer
 * threw away, and payloads that inline hundreds of lines into the chat.
 */
describe("tool result presentation", () => {
  it("renders the adapter's readable result INSTEAD of the raw payload", () => {
    // The whole User Testing bug: `attached-to-tool` carries the result only
    // in `traceDisplayText`, nothing read it, and the tool card fell back to
    // dumping `output` as JSON.
    const messages = [
      assistantParts([
        toolPart({
          toolName: "find_invoices",
          input: { status: "unpaid" },
          output: { rows: [{ id: "inv_1", total: 4200 }] },
          traceDisplayText: "Found 1 unpaid invoice totalling $42.00.",
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).toContain(
      "Found 1 unpaid invoice totalling $42.00.",
    );
    expect(container.textContent).toContain("Result");
    // ...and NOT beside its own translation: showing both would put the dump
    // straight back into the transcript. Asserted on the payload's own values
    // rather than on the word "Output", which the tool STATE label also
    // contains ("Output available").
    expect(container.textContent).not.toContain("inv_1");
    expect(container.textContent).not.toContain("4200");
  });

  it("still shows the raw payload when the adapter produced no readable form", () => {
    // Swarm sessions and any part that never went through the adapter.
    const messages = [
      assistantParts([
        toolPart({ toolName: "search", output: { temp: 72 } }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).toContain("Output");
    expect(container.textContent).toContain('"temp": 72');
  });

  it("ignores a blank readable result rather than hiding the payload", () => {
    // An empty string is not a translation, and treating it as one would lose
    // the only copy of the result.
    const messages = [
      assistantParts([
        toolPart({
          toolName: "search",
          output: { temp: 72 },
          traceDisplayText: "   ",
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).toContain('"temp": 72');
  });

  it("leaves a small payload open, with no control to press", () => {
    const messages = [
      assistantParts([
        toolPart({ toolName: "ping", input: { host: "a" }, output: { ok: 1 } }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).toContain('"ok": 1');
    // A disclosure that only ever reveals what is already visible is noise.
    expect(container.querySelector(".mcpjam-chat-fold-toggle")).toBeNull();
  });

  it("folds a large payload closed, and says how big it is", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `row_${i}`,
      value: i,
    }));
    const messages = [
      assistantParts([toolPart({ toolName: "dump", output: { rows } })]),
    ];
    render(<ReadOnlyTranscript messages={messages} />);

    const toggle = screen.getByRole("button", { name: /Output/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The size, so the reader can tell "two lines I skipped" from "eight
    // hundred" before deciding to open it.
    expect(toggle.textContent).toMatch(/\d+ lines/);
    expect(screen.getByTestId("folded-block-preview")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("folded-block-preview")).toBeNull();
  });

  it("folds a long readable result too — prose can bury a transcript as well", () => {
    const messages = [
      assistantParts([
        toolPart({
          toolName: "report",
          traceDisplayText: Array.from(
            { length: FOLD_LINE_LIMIT + 10 },
            (_, i) => `line ${i}`,
          ).join("\n"),
        }),
      ]),
    ];
    render(<ReadOnlyTranscript messages={messages} />);

    expect(
      screen.getByRole("button", { name: /Result/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("hides a collapsed payload from assistive technology", () => {
    // The collapse is a `max-h` clip, so the hidden remainder stays in the
    // DOM. Unmarked, a screen reader reads the whole payload while the button
    // beside it reports `aria-expanded="false"` — the toggle and the content
    // disagree, and the reader is handed the dump the fold exists to spare
    // them. `inert` rides along as the right primitive for a clipped subtree;
    // no payload renderer emits a focusable node today, so it guards the next
    // one rather than a live leak.
    const lines = Array.from(
      { length: FOLD_LINE_LIMIT + 10 },
      (_, i) => `line ${i}`,
    );
    const messages = [
      assistantParts([
        toolPart({ toolName: "report", traceDisplayText: lines.join("\n") }),
      ]),
    ];
    render(<ReadOnlyTranscript messages={messages} />);

    const preview = screen.getByTestId("folded-block-preview");
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview).toHaveAttribute("inert");
    // The payload really is inside the hidden wrapper, not a sibling of it —
    // otherwise the attributes above would be decoration.
    expect(preview.textContent).toContain("line 0");

    // Expanding drops the wrapper entirely, so nothing has to be un-hidden.
    fireEvent.click(screen.getByRole("button", { name: /Result/ }));
    expect(screen.queryByTestId("folded-block-preview")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Result/ }).closest("div")
        ?.textContent,
    ).toContain("line 0");
  });

  it("keeps the error visible rather than folding it", () => {
    // An error is the reason you opened the session; it is not evidence to be
    // put away behind a disclosure.
    const messages = [
      assistantParts([
        toolPart({
          toolName: "broken",
          state: "output-error",
          errorText: "boom: it failed",
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).toContain("boom: it failed");
    expect(container.querySelector(".mcpjam-chat-fold-toggle")).toBeNull();
  });
});

/**
 * A host that supplies `renderTool` replaces the package's tool block
 * entirely, so anything the package reads off the part has to reach the
 * override through `ToolRenderContext` or it is lost. `resultText` is the one
 * BB-198 added, and it is the whole point of the change — an override left
 * without it shows the raw payload for exactly the sessions this fixes.
 */
describe("renderTool override", () => {
  it("receives the adapter's readable result in its context", () => {
    const seen: ToolRenderContext[] = [];
    const messages = [
      assistantParts([
        toolPart({
          toolName: "find_invoices",
          output: { rows: [{ id: "inv_1" }] },
          traceDisplayText: "Found 1 unpaid invoice totalling $42.00.",
        }),
      ]),
    ];

    const { container } = render(
      <Transcript
        messages={messages}
        renderTool={(ctx) => {
          seen.push(ctx);
          return <div>host block: {ctx.resultText}</div>;
        }}
      />,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.resultText).toBe(
      "Found 1 unpaid invoice totalling $42.00.",
    );
    // And it is usable, not just present.
    expect(container.textContent).toContain(
      "host block: Found 1 unpaid invoice totalling $42.00.",
    );
  });

  it("leaves it undefined for a part the adapter never touched", () => {
    const seen: ToolRenderContext[] = [];
    render(
      <Transcript
        messages={[assistantParts([toolPart({ toolName: "search" })])]}
        renderTool={(ctx) => {
          seen.push(ctx);
          return null;
        }}
      />,
    );

    expect(seen[0]!.resultText).toBeUndefined();
  });
});

describe("fold thresholds", () => {
  it("folds on line count", () => {
    expect(shouldFold("a\n".repeat(FOLD_LINE_LIMIT - 2))).toBe(false);
    expect(shouldFold("a\n".repeat(FOLD_LINE_LIMIT + 2))).toBe(true);
  });

  it("folds on one very long line, which a line count cannot see", () => {
    expect(shouldFold("x".repeat(FOLD_CHAR_LIMIT + 1))).toBe(true);
  });

  it("counts lines without a trailing-newline off-by-one", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\n")).toBe(2);
  });
});
