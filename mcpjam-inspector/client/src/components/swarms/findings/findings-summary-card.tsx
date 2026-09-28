/**
 * The summary card at the top of the Findings tab: kicker, the finding, then
 * the suggested fix. Accent orbs stay in the corner as decoration — they must
 * not reserve a text column. The orbs use the `primary` role token; literal
 * hex is forbidden by AGENTS.md.
 *
 * The template arrives as SENTENCES and joins into ONE PARAGRAPH. Lane A's
 * suggested fix, when present, follows that paragraph — the template is
 * what the card says when there is no model line to promote.
 */

import { SectionLabel } from "@/components/shared/section-label";
import { FindingText } from "@/components/shared/actionable-insights/finding-text";

export function FindingsSummaryCard({
  sessionCount,
  summary,
  recommendation,
  narration,
  launchReason,
}: {
  sessionCount: number;
  /** 1–4 sentences, joined into one paragraph here. */
  summary: readonly string[];
  /**
   * The suggested fix for the cause the summary just named. Shown on its own
   * labelled block under the paragraph — never instead of it. Optional, and
   * User Testing passes none.
   */
  recommendation?: string | null;
  /**
   * Lane A's wave prose, which REPLACES the composed paragraph. A different
   * thing from a fix, and kept a different prop for that reason: labelling a
   * narration "Suggested fix" would tell a reader to go and do a description.
   */
  narration?: string | null;
  /**
   * Why sessions in this wave never ran, from the attempts that refused them.
   * The paragraph can only count them ("15 of 15 sessions failed to launch.");
   * this names the refusal, which is the one thing a reader of a wave that
   * never ran needs (#5188). Swarm only.
   */
  launchReason?: string | null;
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
      className="relative overflow-hidden rounded-xl border border-border bg-card px-7 py-5 pr-12 shadow-sm"
      aria-labelledby="swarm-findings-headline"
      data-testid="findings-summary-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-12 size-28 rounded-full bg-primary opacity-80"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-2 -top-8 size-20 rounded-full bg-primary opacity-30"
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
        <div className="mt-2 space-y-4" data-testid="findings-summary-body">
          <div data-testid="findings-summary">
            {/* A <p>, not an <h2>. Body size, full card width: a display
                measure left most of a normal viewport empty. `H` navigation
                should not land on a paragraph of prose. */}
            <p
              className="text-pretty text-base leading-relaxed text-foreground"
              data-testid="findings-headline"
            >
              <FindingText text={headline} />
            </p>
          </div>
          {launchReason?.trim() ? (
            <div data-testid="findings-launch-reason">
              <SectionLabel>Why sessions didn't run</SectionLabel>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {launchReason.trim()}
              </p>
            </div>
          ) : null}
          {fix ? (
            // Own block, not a child of the summary paragraph:
            // `SectionLabel` renders a <p>, and a paragraph inside a
            // paragraph is invalid HTML.
            <div data-testid="findings-suggested-fix">
              <SectionLabel>Suggested fix</SectionLabel>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                <FindingText text={fix} />
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
