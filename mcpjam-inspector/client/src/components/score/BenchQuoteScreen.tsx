/**
 * What the run costs, what it will do, and what the visitor is agreeing to.
 *
 * Everything on this screen exists because discovering it afterwards is worse:
 *
 *   - The exam's IDENTITY and version, because a score is only comparable to
 *     another score of the same exam.
 *   - The estimate against what is available, because a run refused halfway is
 *     a run that already wrote into somebody's tenant.
 *   - The write preview and its explicit consent, because "we may create and
 *     then delete a page in your workspace" is not something to infer from a
 *     category name. Consent is per-manifest and travels as a hash, so an exam
 *     that GAINS a write case after this screen was shown cannot be admitted
 *     against consent given for a read-only one.
 *   - A guest's daily contribution being NON-REFUNDABLE. The daily buckets
 *     roll and there is no reconciliation machinery to hand part of one back;
 *     the honest place to say so is before the button, not after a cancel.
 *
 * The estimate is rendered, never recomputed. A total assembled here would
 * disagree with the ceiling admission actually holds the moment the backend
 * adds a line item.
 */

import { useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import { AlertTriangle, Loader2, PencilLine } from "lucide-react";
import type {
  BenchEstimateBreakdown,
  BenchQuote,
} from "@/lib/apis/bench-api";

/** Integer USD micros → the dollars a person reads. */
function formatMicros(micros: number | null | undefined): string | null {
  if (typeof micros !== "number" || !Number.isFinite(micros)) return null;
  const dollars = micros / 1_000_000;
  return dollars >= 1
    ? `$${dollars.toFixed(2)}`
    : `$${dollars.toFixed(3).replace(/0$/, "")}`;
}

function formatWallClock(ms: number | undefined): string | null {
  if (typeof ms !== "number" || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const ESTIMATE_LABELS: Array<[keyof BenchEstimateBreakdown, string]> = [
  ["cellsMicros", "Running the cases"],
  ["judgesMicros", "Judging the results"],
  ["classifierMicros", "Classifying the connector"],
  ["analyzerMicros", "Explaining the flow"],
];

function EstimateRows({ estimate }: { estimate: BenchEstimateBreakdown }) {
  const rows = ESTIMATE_LABELS.map(([key, label]) => {
    const amount = formatMicros(estimate[key]);
    return amount ? { label, amount } : null;
  }).filter((row): row is { label: string; amount: string } => row !== null);
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {rows.map((row) => (
        <li
          key={row.label}
          className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground"
        >
          <span>{row.label}</span>
          <span className="tabular-nums">{row.amount}</span>
        </li>
      ))}
    </ul>
  );
}

export function BenchQuoteScreen({
  quote,
  loading = false,
  starting = false,
  writeConsent,
  onWriteConsentChange,
  onStart,
  onBack,
  onSignIn,
  onTopUp,
  definitionChanged = false,
  onRequote,
  error,
}: {
  quote: BenchQuote | null;
  loading?: boolean;
  starting?: boolean;
  writeConsent: boolean;
  onWriteConsentChange: (next: boolean) => void;
  onStart: () => void;
  onBack: () => void;
  /** Guest escape hatches. Omitted callers render no CTA rather than a dead one. */
  onSignIn?: () => void;
  onTopUp?: () => void;
  /**
   * The exam moved between this quote and the attempt to start it. The screen
   * refuses to start against the stale plan rather than re-quoting silently —
   * the visitor consented to a specific manifest, and a fresh one is a fresh
   * decision.
   */
  definitionChanged?: boolean;
  onRequote?: () => void;
  error?: string | null;
}) {
  const writes = quote?.writeOperations ?? [];
  const needsWriteConsent = writes.length > 0;
  const guest = quote?.guest;
  const isGuest = quote?.payerKind === "guest_subsidy";

  const total = formatMicros(quote?.quotedMaxMicros);
  const available = formatMicros(quote?.availableMicros ?? undefined);
  const wallClock = formatWallClock(quote?.plan?.estimatedWallClockMs);

  /**
   * Whether the ceiling exceeds what is there to spend. Only computed when the
   * backend supplied BOTH numbers: comparing against an absent balance would
   * warn every visitor whose balance the backend declined to disclose.
   */
  const shortfall = useMemo(() => {
    const max = quote?.quotedMaxMicros;
    const have = quote?.availableMicros;
    if (typeof max !== "number" || typeof have !== "number") return false;
    return have < max;
  }, [quote?.quotedMaxMicros, quote?.availableMicros]);

  const outOfGuestRuns =
    typeof guest?.runsRemainingToday === "number" &&
    guest.runsRemainingToday <= 0;

  const blocked = definitionChanged || outOfGuestRuns;
  const canStart =
    Boolean(quote) &&
    !loading &&
    !starting &&
    !blocked &&
    (!needsWriteConsent || writeConsent);

  if (loading && !quote) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Pricing this run…
      </div>
    );
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">Before we start</h2>
        {quote?.definition ? (
          <p className="text-xs text-muted-foreground">
            {quote.definition.profileId ?? "Benchmark"}
            {quote.definition.version ? ` ${quote.definition.version}` : ""}
            {quote.definition.categorySlug
              ? ` · ${quote.definition.categorySlug}`
              : ""}
          </p>
        ) : null}
        {quote?.definition?.definitionHash ? (
          <p className="font-mono text-[10px] text-muted-foreground/80">
            {/* The identity a rerun has to match to be comparable. */}
            {quote.definition.definitionHash.slice(0, 16)}
          </p>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 rounded-md border border-border/50 px-3 py-2">
          <div className="text-[11px] font-medium">What runs</div>
          <p className="text-[11px] text-muted-foreground">
            {[
              typeof quote?.plan?.cases === "number"
                ? `${quote.plan.cases} case${quote.plan.cases === 1 ? "" : "s"}`
                : null,
              typeof quote?.plan?.cells === "number"
                ? `${quote.plan.cells} cell${quote.plan.cells === 1 ? "" : "s"}`
                : null,
              typeof quote?.plan?.repetitions === "number"
                ? `${quote.plan.repetitions} repetition${
                    quote.plan.repetitions === 1 ? "" : "s"
                  } each`
                : null,
              wallClock,
            ]
              .filter(Boolean)
              .join(" · ") || "The backend did not report a plan."}
          </p>
        </div>

        <div className="space-y-1 rounded-md border border-border/50 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium">Estimate</span>
            {total ? (
              <span className="text-sm font-semibold tabular-nums">{total}</span>
            ) : null}
          </div>
          {quote?.estimate ? <EstimateRows estimate={quote.estimate} /> : null}
          <p className="text-[11px] text-muted-foreground">
            {/* The number held is the worst case, not the expected cost. */}
            A ceiling, not a bill — we hold this much and charge what the run
            actually spends.
            {available ? ` You have ${available}.` : ""}
          </p>
          {shortfall ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              That is more than you have available. Top up, or run a smaller
              track.
            </p>
          ) : null}
        </div>
      </div>

      {needsWriteConsent ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium">
            <PencilLine className="h-3.5 w-3.5" />
            This exam writes to your connector
          </div>
          <ul className="space-y-1">
            {writes.map((operation, index) => (
              <li
                key={`${operation.caseId ?? operation.toolName ?? index}`}
                className="text-[11px] text-muted-foreground"
              >
                <span className="font-medium text-foreground">
                  {operation.toolName ?? operation.caseId ?? "A case"}
                </span>
                {operation.summary ? ` — ${operation.summary}` : ""}
                {operation.artifactNamePrefix ? (
                  <span className="ml-1 font-mono text-[10px]">
                    {operation.artifactNamePrefix}…
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Everything created is named with the run&apos;s own prefix and
            deleted afterwards. We report what was left behind if any of it
            could not be removed.
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={writeConsent}
              onChange={(event) => onWriteConsentChange(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              I agree to these write operations against this connector.
            </span>
          </label>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          This exam only reads. Nothing is created, changed or deleted on your
          connector.
        </p>
      )}

      {isGuest ? (
        <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
          <div className="text-[11px] font-medium">
            Running as a guest
            {typeof guest?.runsRemainingToday === "number"
              ? ` · ${guest.runsRemainingToday} of ${
                  guest.dailyRunLimit ?? 1
                } run${guest.dailyRunLimit === 1 ? "" : "s"} left today`
              : ""}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {/* Stated here, deliberately, rather than discovered afterwards. */}
            Today&apos;s allowance covers this run. It is spent when the run
            starts and is <span className="font-medium">not refundable</span> —
            cancelling, or a run that fails, does not give it back.
          </p>
          {outOfGuestRuns ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              You have used today&apos;s guest run. Sign in to use your own
              credits, or come back tomorrow.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {onSignIn ? (
              <Button size="sm" variant="outline" onClick={onSignIn}>
                Sign in
              </Button>
            ) : null}
            {onTopUp ? (
              <Button size="sm" variant="outline" onClick={onTopUp}>
                Add credits
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {definitionChanged ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px]">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div className="space-y-1.5">
            <p>
              The exam changed while this quote was open, so we did not start
              the run. Price it again and re-read what it does — the previous
              consent covered a different set of cases.
            </p>
            {onRequote ? (
              <Button size="sm" variant="outline" onClick={onRequote}>
                Price it again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-400">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canStart} onClick={onStart}>
          {starting ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Starting…
            </>
          ) : (
            "Start the benchmark"
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={onBack} disabled={starting}>
          Back
        </Button>
      </div>
    </section>
  );
}
