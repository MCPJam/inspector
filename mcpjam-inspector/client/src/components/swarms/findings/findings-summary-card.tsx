/**
 * The dark headline card at the top of the Findings tab: kicker, the
 * deterministic headline, sub, then honesty footnote chips. The dark surface
 * is deliberate in BOTH themes — it is the one loud element on the page.
 */

export function FindingsSummaryCard({
  sessionCount,
  headline,
  sub,
  footnotes,
}: {
  sessionCount: number;
  headline: string;
  sub: string;
  footnotes: readonly string[];
}) {
  return (
    <section
      className="rounded-2xl bg-zinc-900 p-6 text-zinc-50 dark:border dark:border-border/60 sm:p-8"
      aria-labelledby="swarm-findings-headline"
      data-testid="findings-summary-card"
    >
      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-400">
        Finding summary · {sessionCount} session{sessionCount === 1 ? "" : "s"}
      </p>
      <h2
        id="swarm-findings-headline"
        className="mt-3 max-w-4xl text-balance text-2xl font-semibold leading-tight tracking-tight sm:text-3xl"
        data-testid="findings-headline"
      >
        {headline}
      </h2>
      <p className="mt-3 text-sm text-zinc-400">{sub}</p>
      {footnotes.length > 0 ? (
        <div
          className="mt-4 flex flex-wrap gap-1.5"
          data-testid="findings-footnotes"
        >
          {footnotes.map((note) => (
            <span
              key={note}
              className="inline-flex items-center rounded-md bg-white/10 px-2 py-1 text-[11px] text-zinc-300"
            >
              {note}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
