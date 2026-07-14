/**
 * Presentation-side split of httpHistory entries across step cards.
 *
 * Both debuggers' state machines record ONE history entry per HTTP exchange,
 * tagged with the REQUEST step (the response is attached to that same entry —
 * atomically in XAA's runRequest, one click later in the OAuth machines). The
 * loggers, however, want the request to render under the request-step card and
 * the response under the paired received-step card.
 *
 * This module derives display items from the unchanged data. It never mutates
 * or reshapes entries, so nothing observable by the SDK, the CLI projections,
 * or error-guidance changes — only where each half is rendered.
 */

export type HttpEntryView = "request" | "response" | "full";

export interface SplittableHttpEntry<TStep extends string> {
  step: TStep;
  timestamp: number;
  duration?: number;
  response?: unknown;
  error?: unknown;
}

export interface HttpEntryDisplayItem<
  TStep extends string,
  TEntry extends SplittableHttpEntry<TStep>,
> {
  /** Card this item renders under (request step, or its paired received step). */
  step: TStep;
  /** The underlying entry, unmodified. */
  entry: TEntry;
  view: HttpEntryView;
  /** entry.timestamp; for "response" items, timestamp + duration so the
   * response sorts at its arrival time (before the received step's info logs). */
  timestamp: number;
}

export function splitHttpEntriesForDisplay<
  TStep extends string,
  TEntry extends SplittableHttpEntry<TStep>,
>(options: {
  entries: readonly TEntry[];
  /** Received step paired with a request step; undefined = never split. */
  pairedReceivedStep: (step: TStep) => TStep | undefined;
  getStepIndex: (step: TStep) => number;
  /** Index of the flow's current step — responses only move to a received
   * card once that step has actually been reached. */
  reachedIndex: number;
}): HttpEntryDisplayItem<TStep, TEntry>[] {
  const { entries, pairedReceivedStep, getStepIndex, reachedIndex } = options;

  // Only the LATEST entry per request step splits: earlier entries for the
  // same step are failed discovery candidates whose request+response pair is
  // itself the diagnostic.
  const lastIndexForStep = new Map<TStep, number>();
  entries.forEach((entry, index) => {
    lastIndexForStep.set(entry.step, index);
  });

  const items: HttpEntryDisplayItem<TStep, TEntry>[] = [];

  entries.forEach((entry, index) => {
    const full = () =>
      items.push({
        step: entry.step,
        entry,
        view: "full",
        timestamp: entry.timestamp,
      });

    const pair = pairedReceivedStep(entry.step);
    // 1. Unpaired step — nothing to split against.
    if (!pair) return full();
    // 2. Errored exchange — the failure belongs, whole, to the request card.
    if (entry.error) return full();
    // 3. No response yet — genuinely pending, render the request side only.
    if (!entry.response) {
      return items.push({
        step: entry.step,
        entry,
        view: "request",
        timestamp: entry.timestamp,
      });
    }
    // 4. Superseded discovery candidate — keep the pair together.
    if (lastIndexForStep.get(entry.step) !== index) return full();
    // 5. Received step not reached (parked error, terminal probe, or resting
    //    right after the request click) — hide nothing, keep the pair whole.
    if (getStepIndex(pair) > reachedIndex) return full();

    // 6. Split: request under the request card, response under the received card.
    items.push({
      step: entry.step,
      entry,
      view: "request",
      timestamp: entry.timestamp,
    });
    items.push({
      step: pair,
      entry,
      view: "response",
      timestamp: entry.timestamp + (entry.duration ?? 0),
    });
  });

  return items;
}
