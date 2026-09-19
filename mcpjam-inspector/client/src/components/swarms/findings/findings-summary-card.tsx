/**
 * The summary card at the top of the Findings tab: kicker, one headline, then
 * honesty footnote chips. Layout matches the Paper findings mock — a light
 * card with accent orbs on the right. The orbs use the `primary` role token;
 * literal hex is forbidden by AGENTS.md.
 *
 * The template arrives as SENTENCES and joins into ONE PARAGRAPH. Lane A's
 * suggested fix, when present, takes that headline slot — the template is
 * what the card says when there is no model line to promote.
 */

import { SectionLabel } from "@/components/shared/section-label";
import { FindingText } from "@/components/shared/actionable-insights/finding-text";

export function FindingsSummaryCard({
  sessionCount,
  summary,
  recommendation,
  narration,
  footnotes,
}: {
  sessionCount: number;
  /** 1–4 sentences, joined into one paragraph here. */
  summary: readonly string[];
  /**
   * The suggested fix for the cause the summary just named. Shown on its own
   * labelled line BELOW the paragraph — never instead of it. Optional, and
   * User Testing passes none.
   */
  recommendation?: string | null;
  /**
   * Lane A's wave prose, which REPLACES the composed paragraph. A different
   * thing from a fix, and kept a different prop for that reason: labelling a
   * narration "Suggested fix" would tell a reader to go and do a description.
   */
  narration?: string | null;
  footnotes: readonly string[];
}) {
  // Filtered before joining so an empty or whitespace-only sentence cannot
  // leave a double space mid-paragraph. The composers do not emit one today;
  // this costs nothing and means they never have to promise not to.
  const paragraph = summary
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join(" ");
  // The fix USED to replace the paragraph, so a run could name a cause or
  // suggest a fix but never both — the reader got a repair for a problem they
  // were never told about. Two slots, always.
  const fix = recommendation?.trim() || null;
  const headline = narration?.trim() || paragraph;

  return (
    <section
      className="relative overflow-hidden rounded-xl border border-border bg-card py-6 pl-7 pr-32 shadow-sm"
      aria-labelledby="swarm-findings-headline"
      data-testid="findings-summary-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-5 -top-8 size-40 rounded-full bg-primary opacity-90"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-24 -top-8 size-32 rounded-full bg-primary opacity-40"
      />
      <div className="relative">
        {/* The card's LABEL, and what `aria-labelledby` on the section points
            at. A named <section> is a region landmark, so this string is
            announced on entry and listed in the landmark menu — it has to be a
            short name. The summary below is prose and was doing that job
            badly: three sentences read as the region's label, then again as a
            heading, before any content. */}
        <SectionLabel id="swarm-findings-headline">
          Finding summary · {sessionCount} session
          {sessionCount === 1 ? "" : "s"}
        </SectionLabel>
        <div className="max-w-md" data-testid="findings-summary">
          {/* A <p>, not an <h2>. It reads at the size a headline does, but a
              paragraph is what it is, and `H` navigation should not land on
              22 words of prose. */}
          <p
            className="mt-1.5 text-pretty text-2xl font-semibold leading-[1.25] tracking-[-0.02em] text-foreground"
            data-testid="findings-headline"
          >
            <FindingText text={headline} />
          </p>
          {fix ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              <SectionLabel>Suggested fix</SectionLabel>{" "}
              <FindingText text={fix} />
            </p>
          ) : null}
        </div>
        {footnotes.length > 0 ? (
          <div
            className="mt-4 flex flex-wrap gap-1.5"
            data-testid="findings-footnotes"
          >
            {footnotes.map((note) => (
              <span
                key={note}
                className="inline-flex items-center rounded-md border border-border/80 bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground"
              >
                {note}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
