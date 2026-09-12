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
      />
    );
    // One element holding all three. Rendering them as siblings would satisfy
    // the card's own text but not this.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "First sentence. Second sentence. Third sentence."
    );
    expect(
      screen.getByTestId("findings-summary").querySelectorAll("p")
    ).toHaveLength(0);
  });

  it("does not leave a gap where an empty sentence was", () => {
    // Neither composer emits one today. This is what lets them never have to
    // promise not to — a blank string joined naively reads as a typo.
    render(
      <FindingsSummaryCard
        sessionCount={1}
        summary={["The discovery stage broke.", "   ", "", "Maya left lost."]}
        footnotes={[]}
      />
    );
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "The discovery stage broke. Maya left lost."
    );
  });

  it("still names the session count and the footnotes", () => {
    render(
      <FindingsSummaryCard
        sessionCount={1}
        summary={["Nothing graded yet."]}
        footnotes={["Rubric findings only"]}
      />
    );
    // Singular, because one session is one session.
    expect(screen.getByTestId("findings-summary-card").textContent).toContain(
      "Finding summary · 1 session"
    );
    expect(screen.getByTestId("findings-footnotes").textContent).toContain(
      "Rubric findings only"
    );
  });
});
