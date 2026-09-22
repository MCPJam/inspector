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
        footnotes={[]}
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
        footnotes={[]}
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
        footnotes={[]}
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
        footnotes={[]}
      />,
    );
    // The fix used to replace the paragraph, so a run could name a cause or
    // suggest a fix but never both.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "First sentence. Second sentence.",
    );
    expect(screen.getByTestId("findings-summary").textContent).toContain(
      "Fix the lookup before calling downstream tools.",
    );
    expect(screen.getByTestId("findings-summary").textContent).toContain(
      "Suggested fix",
    );
  });

  it("lets Lane A's wave prose replace the paragraph, as it always has", () => {
    render(
      <FindingsSummaryCard
        sessionCount={3}
        summary={["First sentence."]}
        narration="Lane A said this."
        footnotes={[]}
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

  it("still names the session count and the footnotes", () => {
    render(
      <FindingsSummaryCard
        sessionCount={1}
        summary={["Nothing graded yet."]}
        footnotes={["Rubric findings only"]}
      />,
    );
    // Singular, because one session is one session.
    expect(screen.getByTestId("findings-summary-card").textContent).toContain(
      "Finding summary · 1 session",
    );
    expect(screen.getByTestId("findings-footnotes").textContent).toContain(
      "Rubric findings only",
    );
  });
});
