/**
 * What to score this connector AS.
 *
 * The classifier reads the target's tool surface and proposes a ranking. Three
 * rules make that proposal safe to show:
 *
 *   1. It is a PROPOSAL. The visitor's choice wins, always, and choosing
 *      against the ranking is a legitimate thing to do — running a tracker as
 *      a CRM produces a real Workflow Reliability measurement of a real
 *      mismatch, not a taxonomy edit.
 *   2. A classifier that produced nothing is not a gate. When the receipt
 *      carries no ranking, the full runnable list is offered instead. A
 *      convenience that breaks must never be able to stop a run.
 *   3. Confidence and rationale travel with the ranking. A bare "we think this
 *      is a CRM" invites the visitor to defer to it; "0.42, because three tools
 *      mention contacts" invites them to disagree.
 *
 * Unrunnable categories stay VISIBLE with their reason. Hiding them would make
 * a target that advertises nothing look identical to one whose category is
 * simply not offered yet.
 */

import { useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import { ArrowRight, Info } from "lucide-react";
import type {
  BenchCategory,
  BenchClassification,
  BenchPreferences,
  BenchTrack,
} from "@/lib/apis/bench-api";
import { cn } from "@/lib/utils";

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% confidence`;
}

/**
 * The categories, in the order the visitor should read them.
 *
 * A ranking reorders; it never filters. Every runnable category the backend
 * offered is present either way, so a low-confidence classification cannot
 * quietly remove the option the visitor came for.
 */
function orderByRanking(
  categories: BenchCategory[],
  classification: BenchClassification | undefined,
): BenchCategory[] {
  const ranked = classification?.ranked;
  if (!ranked || ranked.length === 0) return categories;
  const rank = new Map(ranked.map((entry, index) => [entry.categorySlug, index]));
  return [...categories].sort((a, b) => {
    const left = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

export function BenchCategorySelector({
  categories,
  tracks,
  classification,
  preferences,
  selectedCategoryId,
  selectedTrackId,
  onSelectCategory,
  onSelectTrack,
  onContinue,
  busy = false,
}: {
  categories: BenchCategory[];
  tracks: BenchTrack[];
  classification?: BenchClassification;
  /** The backend's per-actor prefill, shown so a returning visitor sees why. */
  preferences?: BenchPreferences;
  selectedCategoryId: string | null;
  selectedTrackId: string | null;
  onSelectCategory: (categoryId: string) => void;
  onSelectTrack: (trackId: string) => void;
  onContinue: () => void;
  busy?: boolean;
}) {
  const ordered = useMemo(
    () => orderByRanking(categories, classification),
    [categories, classification],
  );
  const rationale = useMemo(() => {
    const map = new Map<string, { confidence: number; rationale?: string }>();
    for (const entry of classification?.ranked ?? []) {
      map.set(entry.categorySlug, {
        confidence: entry.confidence,
        ...(entry.rationale ? { rationale: entry.rationale } : {}),
      });
    }
    return map;
  }, [classification]);

  const unclassified = !classification?.ranked?.length;
  // Preflight only lists tracks that HAVE an active definition, so every
  // track it returns is runnable; there is no flag to filter on.
  const runnableTracks = tracks;
  const selectedCategory = ordered.find(
    (category) => category.id === selectedCategoryId,
  );
  const canContinue =
    Boolean(selectedCategory?.runnable) && Boolean(selectedTrackId) && !busy;

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">What is this connector for?</h2>
        <p className="text-xs text-muted-foreground">
          The exam is chosen by category, so the checks match what the connector
          claims to do. Pick a different one if we read it wrong — the result is
          still a real measurement, just of a different question.
        </p>
      </header>

      {unclassified ? (
        <div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {/* Rule 2. Never a gate. */}
            We couldn&apos;t classify this connector
            {classification?.failureReason
              ? ` (${classification.failureReason})`
              : ""}
            , so every category we can run is listed below. Nothing about the
            run changes — you just pick it yourself.
          </span>
        </div>
      ) : null}

      {preferences?.categorySlug ? (
        <p className="text-[11px] text-muted-foreground">
          Pre-filled from the last time you scored this connector. It is a
          convenience for you alone: it does not change how anyone else sees
          this server, and it can never make a result public.
        </p>
      ) : null}

      <ul className="space-y-1.5" aria-label="Categories">
        {ordered.map((category) => {
          const receipt = rationale.get(category.id);
          const selected = category.id === selectedCategoryId;
          return (
            <li key={category.id}>
              <button
                type="button"
                disabled={!category.runnable || busy}
                aria-pressed={selected}
                onClick={() => onSelectCategory(category.id)}
                className={cn(
                  "w-full rounded-md border px-3 py-2 text-left transition-colors",
                  selected
                    ? "border-foreground/40 bg-muted/40"
                    : "border-border/50 hover:bg-muted/20",
                  !category.runnable && "cursor-not-allowed opacity-60",
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-medium">{category.title}</span>
                  {receipt ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {confidenceLabel(receipt.confidence)}
                    </span>
                  ) : null}
                </div>
                {receipt?.rationale ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {receipt.rationale}
                  </p>
                ) : null}
                {!category.runnable ? (
                  <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                    No exam has been published for this category yet.
                  </p>
                ) : category.description ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {category.description}
                  </p>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold">Track</h3>
        {runnableTracks.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No track is runnable against this connector yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5" aria-label="Tracks">
            {runnableTracks.map((track) => (
              <button
                key={track.id}
                type="button"
                disabled={busy}
                aria-pressed={track.id === selectedTrackId}
                onClick={() => onSelectTrack(track.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] transition-colors",
                  track.id === selectedTrackId
                    ? "border-foreground/40 bg-muted/50 font-medium"
                    : "border-border/50 hover:bg-muted/20",
                )}
              >
                {track.id}
              </button>
            ))}
          </div>
        )}
      </div>

      <Button size="sm" disabled={!canContinue} onClick={onContinue}>
        See what this costs
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
      </Button>
    </section>
  );
}
