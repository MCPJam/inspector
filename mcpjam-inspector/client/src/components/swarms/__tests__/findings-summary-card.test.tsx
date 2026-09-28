import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { FindingsSummaryCard } from "../findings/findings-summary-card";

/**
 * The card takes SENTENCES and renders ONE PARAGRAPH.
 *
 * Both composers keep answering the four questions as separate strings, so
 * each answer stays assertable on its own; the joining lives here. Vignesh
 * asked for one flowing paragraph rather than the stacked lines this card used
 * to render (standup, 2026-09-12), and these are the cases where "joined" and
 * "stacked" would otherwise look the same in a test.
 */

describe("FindingsSummaryCard", () => {
  it("joins the sentences into a single paragraph element", () => {
    render(
      <FindingsSummaryCard
        sessionCount={3}
        summary={["First sentence.", "Second sentence.", "Third sentence."]}
      />,
    );
    // One element holding all three. Rendering them as siblings would satisfy
    // the card's own text but not this.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "First sentence. Second sentence. Third sentence.",
    );
    // ONE child, whatever element it is. The old form counted <p> elements,
    // which pinned the summary being an <h2> rather than the sentences being
    // joined — the thing this test is for.
    expect(screen.getByTestId("findings-summary").children).toHaveLength(1);
  });

  it("names the card with the kicker, not with the summary", () => {
    render(
      <FindingsSummaryCard
        sessionCount={3}
        summary={["First sentence.", "Second sentence.", "Third sentence."]}
      />,
    );
    // A named <section> is a region landmark: this string is announced on
    // entering the card and listed in the landmark menu. Labelling it from the
    // summary meant hearing all three sentences as the label, then again as
    // the content. A landmark wants a short name.
    expect(
      screen.getByRole("region", { name: "Finding summary · 3 sessions" }),
    ).toBeInTheDocument();
    // And no heading, because prose at heading size is still prose — `H`
    // navigation should not land on the whole summary.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("does not leave a gap where an empty sentence was", () => {
    // Neither composer emits one today. This is what lets them never have to
    // promise not to — a blank string joined naively reads as a typo.
    render(
      <FindingsSummaryCard
        sessionCount={1}
        summary={["The discovery stage broke.", "   ", "", "Maya left lost."]}
      />,
    );
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "The discovery stage broke. Maya left lost.",
    );
  });

  it("shows a suggested fix BESIDE the summary, never instead of it", () => {
    render(
      <FindingsSummaryCard
        sessionCount={3}
        summary={["First sentence.", "Second sentence."]}
        recommendation="Fix the lookup before calling downstream tools."
      />,
    );
    // The fix used to replace the paragraph, so a run could name a cause or
    // suggest a fix but never both.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "First sentence. Second sentence.",
    );
    // Sibling of the summary, not nested inside it — the card names a cause
    // and a fix as two slots, and the summary block is only the cause.
    expect(screen.getByTestId("findings-summary").textContent).not.toContain(
      "Suggested fix",
    );
    expect(screen.getByTestId("findings-suggested-fix").textContent).toContain(
      "Fix the lookup before calling downstream tools.",
    );
    expect(screen.getByTestId("findings-suggested-fix").textContent).toContain(
      "Suggested fix",
    );
  });

  it("lets Lane A's wave prose replace the paragraph, as it always has", () => {
    render(
      <FindingsSummaryCard
        sessionCount={3}
        summary={["First sentence."]}
        narration="Lane A said this."
      />,
    );
    // A narration is not a fix; it keeps the legacy promotion and never gets
    // labelled as something to go and do.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "Lane A said this.",
    );
    expect(screen.getByTestId("findings-summary").textContent).not.toContain(
      "Suggested fix",
    );
  });

  it("still names the session count in the singular", () => {
    render(
      <FindingsSummaryCard
        sessionCount={1}
        summary={["Nothing graded yet."]}
      />,
    );
    // Singular, because one session is one session.
    expect(screen.getByTestId("findings-summary-card").textContent).toContain(
      "Finding summary · 1 session",
    );
    expect(screen.queryByTestId("findings-footnotes")).not.toBeInTheDocument();
  });

  it("names why sessions didn't run in its own block, beside the count", () => {
    // MCPJam/inspector#5188: the paragraph counts the refused sessions; the
    // refusal itself is its own line, never folded into the paragraph.
    render(
      <FindingsSummaryCard
        sessionCount={0}
        summary={["No sessions launched.", "3 of 3 sessions failed to launch."]}
        launchReason="Persona turn failed: 400 invalid identity"
      />,
    );
    const reason = screen.getByTestId("findings-launch-reason");
    expect(reason).toHaveTextContent("Why sessions didn't run");
    expect(reason).toHaveTextContent(
      "Persona turn failed: 400 invalid identity",
    );
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "No sessions launched. 3 of 3 sessions failed to launch.",
    );
  });

  it("renders no reason block without a reason", () => {
    render(
      <FindingsSummaryCard
        sessionCount={3}
        summary={["First sentence."]}
        launchReason="   "
      />,
    );
    expect(
      screen.queryByTestId("findings-launch-reason"),
    ).not.toBeInTheDocument();
  });
});
