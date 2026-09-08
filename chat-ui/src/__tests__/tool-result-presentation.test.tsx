import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ReadOnlyTranscript } from "../read-only-transcript";
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
