/**
 * The summary card at the top of the Findings tab: kicker, the deterministic
 * summary, then honesty footnote chips. Layout matches the Paper findings mock
 * — a light card with accent orbs on the right. The orbs use the `primary`
 * role token; literal hex is forbidden by AGENTS.md.
 *
 * The summary arrives as lines, not one headline: the reader needs the goal,
 * the persona, the stage and the feeling, and that does not fit on one line.
 * The first line leads at display size; the rest support it.
 */

export function FindingsSummaryCard({
  sessionCount,
  summary,
  footnotes,
}: {
  sessionCount: number;
  /** 1–4 short lines. The first is the lead. */
  summary: readonly string[];
  footnotes: readonly string[];
}) {
  const [lead, ...rest] = summary;

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
            {lead}
          </h2>
          {rest.length > 0 ? (
            <div className="mt-2 space-y-1">
              {rest.map((line) => (
                <p
                  key={line}
                  className="text-pretty text-base leading-snug text-muted-foreground"
                >
                  {line}
                </p>
              ))}
            </div>
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
