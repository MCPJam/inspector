import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ReadOnlyTranscript, Transcript } from "../read-only-transcript";
import type { ToolRenderContext } from "../types";
import { assistantParts, toolPart } from "./factories";
import { ToolCallPart } from "../tool-call-part";
import { JsonView } from "../parts/json-view";

/**
 * Open every tool card on screen. They start collapsed — see the block comment
 * on the "collapsing" describe below — so a test about what a card SHOWS has
 * to open it first, and one that forgets will read an empty container rather
 * than a wrong one.
 */
function openToolCards() {
  for (const header of screen.getAllByTestId("tool-card-header")) {
    if (header.getAttribute("aria-expanded") === "false") {
      fireEvent.click(header);
    }
  }
}

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
    openToolCards();

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
    openToolCards();

    // Headed RESULT, not "Output" — the card wears the inspector's wording.
    expect(container.textContent).toContain("Result");
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
    openToolCards();

    expect(container.textContent).toContain('"temp": 72');
  });

  it("ignores a mode it does not recognise rather than guessing markdown", () => {
    // The mode is the producer's claim that the text is markdown. A reader
    // that does not understand the claim falls back to the payload, which is
    // always still correct — rendering an unknown future mode as markdown
    // anyway is a renderer lying about content it cannot read.
    const messages = [
      assistantParts([
        toolPart({
          toolName: "search",
          output: { temp: 72 },
          traceDisplayText: "not markdown at all",
          traceDisplayMode: "some-future-mode",
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    openToolCards();

    expect(container.textContent).not.toContain("not markdown at all");
    expect(container.textContent).toContain('"temp": 72');
  });

  it("accepts the modes the adapter actually writes", () => {
    const messages = [
      assistantParts([
        toolPart({
          toolName: "search",
          output: { temp: 72 },
          traceDisplayText: "It is 72 degrees.",
          traceDisplayMode: "markdown",
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);
    openToolCards();

    expect(container.textContent).toContain("It is 72 degrees.");
    expect(container.textContent).not.toContain('"temp": 72');
  });

  it("puts a small payload behind the card too", () => {
    // The old card folded per payload and left short ones open, on the
    // grounds that a disclosure revealing what is already visible is noise.
    // The card collapsing as a whole answers a different question — how much
    // of the screen one tool call is allowed — and a call that renders its
    // header plus two lines while its neighbour renders a header is a ragged
    // transcript, not a considerate one.
    const messages = [
      assistantParts([
        toolPart({ toolName: "ping", input: { host: "a" }, output: { ok: 1 } }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).not.toContain('"ok": 1');
    openToolCards();
    expect(container.textContent).toContain('"ok": 1');
  });

  it("renders nothing of a collapsed payload, rather than hiding it visually", () => {
    // The fold this replaces collapsed by CLIPPING: the whole payload stayed
    // in the DOM behind a `max-h`, which is why it needed `aria-hidden` and
    // `inert` to stop a screen reader being read four hundred lines while the
    // toggle beside it said collapsed. A closed card mounts none of it, so
    // there is nothing to mark and nothing to get wrong.
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `row_${i}`,
      value: i,
    }));
    const messages = [
      assistantParts([toolPart({ toolName: "dump", output: { rows } })]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).not.toContain("row_0");
    expect(screen.queryByTestId("folded-block-preview")).toBeNull();

    const header = screen.getByTestId("tool-card-header");
    expect(header).toHaveAttribute("aria-expanded", "false");
    // The name is still there closed — the transcript says WHICH tool ran
    // without saying what it returned.
    expect(container.textContent).toContain("dump");

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(container.textContent).toContain("row_0");
  });

  it("collapses a long readable result too — prose can bury a transcript as well", () => {
    const messages = [
      assistantParts([
        toolPart({
          toolName: "report",
          traceDisplayText: Array.from(
            { length: 30 },
            (_, i) => `line ${i}`,
          ).join(String.fromCharCode(10)),
        }),
      ]),
    ];
    const { container } = render(<ReadOnlyTranscript messages={messages} />);

    expect(container.textContent).not.toContain("line 0");
    openToolCards();
    expect(container.textContent).toContain("line 0");
  });

  it("opens a FAILED call by itself", () => {
    // An error is the reason you opened the session; it is not evidence to be
    // put away behind a disclosure. This is the one case where the card does
    // not start closed, and it is why `defaultOpen` is a tri-state rather than
    // a boolean that defaults to false.
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

    expect(screen.getByTestId("tool-card-header")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(container.textContent).toContain("boom: it failed");
  });

  it("opens a call that fails AFTER it was rendered", () => {
    // A streaming call mounts long before it fails, and `MessageView` keys a
    // tool part by its `toolCallId`, so the same component is still there when
    // the error lands. Reading `hasError` once, in a `useState` initialiser,
    // left the card collapsed over exactly the failure the rule above exists
    // to surface. Caught in review on #5097.
    const { container, rerender } = render(
      <ToolCallPart toolName="broken" toolState="input-available" />,
    );
    expect(container.textContent).not.toContain("boom");

    rerender(
      <ToolCallPart
        toolName="broken"
        toolState="output-error"
        errorText="boom: it failed"
      />,
    );
    expect(container.textContent).toContain("boom: it failed");
  });

  it("keeps a card the reader closed shut", () => {
    // Their answer outranks ours. Asserted on the toggle rather than on a
    // prop, because this is the half of the fix a derived default could have
    // broken: recomputing on every render would re-open it under them.
    render(<ToolCallPart toolName="ping" input={{ host: "a" }} defaultOpen />);

    const header = screen.getByTestId("tool-card-header");
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("lets an explicit defaultOpen win in both directions", () => {
    // A host showing ONE call rather than a transcript of them wants it open;
    // one showing a wall of failures wants them closed. Asserted on the
    // component directly — the transcript does not expose the prop.
    const { container: openContainer } = render(
      <ToolCallPart toolName="ping" input={{ host: "a" }} defaultOpen />,
    );
    expect(openContainer.textContent).toContain('"host": "a"');

    const { container: closedContainer } = render(
      <ToolCallPart
        toolName="broken"
        errorText="boom"
        defaultOpen={false}
      />,
    );
    expect(closedContainer.textContent).not.toContain("boom");
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

  it("applies the same emptiness test the card does", () => {
    // The two readers used to disagree: the card required non-blank text, the
    // context accepted any non-empty string. A host following the
    // `ToolRenderContext` doc ("prefer it over `output` when present") then
    // rendered an empty Result and dropped the payload — the BB-198 failure,
    // just on the far side of the seam.
    const seen: ToolRenderContext[] = [];
    render(
      <Transcript
        messages={[
          assistantParts([
            toolPart({
              toolName: "s",
              output: { temp: 72 },
              traceDisplayText: "   ",
            }),
          ]),
        ]}
        renderTool={(ctx) => {
          seen.push(ctx);
          return null;
        }}
      />,
    );

    expect(seen[0]!.resultText).toBeUndefined();
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

describe("JsonView", () => {
  it("shows the text it was handed instead of re-serialising the value", () => {
    // `FoldedBlock` has to serialise a payload to size it. Passing that string
    // back in is what stops a large tool result being stringified twice on
    // every render, and it is what makes "the text measured is the text shown"
    // a guarantee rather than two call sites branching the same way by habit.
    const { container } = render(
      <JsonView value={{ never: "rendered" }} text="the measured text" />,
    );

    expect(container.textContent).toBe("the measured text");
  });

  it("still serialises the value when no text is supplied", () => {
    const { container } = render(<JsonView value={{ ok: 1 }} />);

    expect(container.textContent).toContain('"ok": 1');
  });
});
