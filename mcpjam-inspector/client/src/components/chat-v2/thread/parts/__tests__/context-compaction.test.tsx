import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ContextCompactedLine,
  TruncatedResultNotice,
  contextCompactionReportOf,
  shortenedResultFor,
} from "../context-compaction";

/**
 * PLB-300: the chat says when the model got less than a tool result. A
 * shortened result gets a notice on its card; cleared older results get one
 * "Context compacted" line in the turn.
 */

const report = {
  shortened: [
    {
      toolCallId: "call-download",
      toolName: "download_quote_document",
      originalTokens: 683_162,
      keptTokens: 24_728,
    },
  ],
  cleared: [
    { toolCallId: "call-a", toolName: "get_shipment_events", tokens: 15_212 },
    { toolCallId: "call-b", toolName: "get_shipment_events", tokens: 14_876 },
  ],
};
const part = { type: "data-context-compaction", id: "c-1", data: report };

describe("context compaction parts", () => {
  it("reads the report only from a well-formed compaction part", () => {
    expect(contextCompactionReportOf(part)).toBe(report);
    expect(
      contextCompactionReportOf({ type: "data-context-compaction", data: {} }),
    ).toBeUndefined();
    expect(contextCompactionReportOf({ type: "text", text: "hi" })).toBe(
      undefined,
    );
  });

  it("finds a call's shortened entry among the message parts", () => {
    const parts = [{ type: "text", text: "hi" }, part];
    expect(shortenedResultFor(parts, "call-download")?.keptTokens).toBe(24_728);
    expect(shortenedResultFor(parts, "call-a")).toBeUndefined();
    expect(shortenedResultFor(undefined, "call-download")).toBeUndefined();
  });

  it("tells the user how much of the result the model got and what to change", () => {
    render(<TruncatedResultNotice entry={report.shortened[0]} />);
    const notice = screen.getByTestId("tool-result-truncated");
    expect(notice).toHaveTextContent(
      "The model got 25K of 683K tokens from this result",
    );
    expect(notice).toHaveTextContent(
      "Return less from this tool, or a link instead of file contents",
    );
  });

  it("lists cleared results and shows each one in its own thread", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = render(
      <div>
        <div data-message-id="m1">
          <div data-tool-call-id="call-a">
            <div role="button" tabIndex={0}>
              get_shipment_events
            </div>
          </div>
        </div>
        <div data-message-id="m2">
          <ContextCompactedLine cleared={report.cleared} />
        </div>
      </div>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Context compacted\s+2 older tool results cleared/,
      }),
    );
    expect(screen.getByText("15,212 tokens")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Show in chat" })[0]);
    const card = container.querySelector('[data-tool-call-id="call-a"]');
    expect(scrollIntoView.mock.contexts[0]).toBe(card);
    expect(document.activeElement).toBe(card?.firstElementChild);
  });

  it("says result, not results, for one cleared result", () => {
    render(<ContextCompactedLine cleared={report.cleared.slice(0, 1)} />);
    expect(
      screen.getByText("1 older tool result cleared", { exact: false }),
    ).toBeInTheDocument();
  });
});
