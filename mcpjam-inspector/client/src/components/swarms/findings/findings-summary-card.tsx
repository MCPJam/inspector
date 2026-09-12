/**
 * The summary card at the top of the Findings tab: kicker, the deterministic
 * summary, then honesty footnote chips. Layout matches the Paper findings mock
 * — a light card with accent orbs on the right. The orbs use the `primary`
 * role token; literal hex is forbidden by AGENTS.md.
 *
 * The summary arrives as SENTENCES and renders as ONE PARAGRAPH.
 *
 * It still needs to name the goal, the persona, the stage and the feeling, so
 * the composers keep producing those as separate strings — each one is tested
 * on its own, and a joined blob would be far harder to assert against. The
 * joining happens here, at the presentation layer, because that is what it is:
 * Vignesh asked for one flowing paragraph rather than the stacked lines this
 * card used to render (standup, 2026-09-12).
 */

export function FindingsSummaryCard({
  sessionCount,
  summary,
  footnotes,
}: {
  sessionCount: number;
  /** 1–4 sentences, joined into one paragraph here. */
  summary: readonly string[];
  footnotes: readonly string[];
}) {
  // Filtered before joining so an empty or whitespace-only sentence cannot
  // leave a double space mid-paragraph. The composers do not emit one today;
  // this costs nothing and means they never have to promise not to.
  const paragraph = summary
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join(" ");

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
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Finding summary · {sessionCount} session
          {sessionCount === 1 ? "" : "s"}
        </p>
        <div className="max-w-md" data-testid="findings-summary">
          <h2
            id="swarm-findings-headline"
            className="mt-1.5 text-pretty text-2xl font-semibold leading-[1.25] tracking-[-0.02em] text-foreground"
            data-testid="findings-headline"
          >
            {paragraph}
          </h2>
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
