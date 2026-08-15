/**
 * How a session's feedback rollup is announced — stars, thumbs, or both.
 *
 * Shared by the sessions list row and the thread detail header so the two can
 * never disagree about what a session's feedback says. The rule is derived
 * from the counts alone: the backend deliberately stores NO `style` field on
 * the summary, because a session can hold rows from both widgets (a scenario
 * whose style was switched mid-session) and there is no single style to name.
 *
 * `count` is every rated turn; `thumbUpCount`/`thumbDownCount` are the thumb
 * subset and are absent rather than zero when there are none. The remainder is
 * therefore the star rows, and a session with both is `mixed`.
 *
 * The AMBER predicate is deliberately not in here: it keys on `min <= 2`,
 * which is the same for both styles precisely because thumbs are projected
 * onto the 1–5 axis server-side.
 */

export interface FeedbackSummaryLike {
  count: number;
  avg: number;
  min: number;
  thumbUpCount?: number;
  thumbDownCount?: number;
}

export type FeedbackHeadline =
  | { kind: "stars"; avg: number; count: number }
  | { kind: "thumbs"; up: number; down: number; count: number }
  | { kind: "mixed"; avg: number; count: number; up: number; down: number };

export function feedbackHeadline(
  summary: FeedbackSummaryLike
): FeedbackHeadline {
  const up = summary.thumbUpCount ?? 0;
  const down = summary.thumbDownCount ?? 0;
  const thumbCount = up + down;

  if (thumbCount === 0) {
    return { kind: "stars", avg: summary.avg, count: summary.count };
  }
  // Every rated turn is a thumb ⇒ there is no average worth showing. `/5` on a
  // session where nobody was offered a 5 is a number the tester never gave.
  if (thumbCount >= summary.count) {
    return { kind: "thumbs", up, down, count: summary.count };
  }
  return { kind: "mixed", avg: summary.avg, count: summary.count, up, down };
}

/** `👍 3 · 👎 1`, with a zero side dropped rather than shown as `👎 0`. */
export function formatThumbCounts(up: number, down: number): string {
  const parts: string[] = [];
  if (up > 0) parts.push(`👍 ${up}`);
  if (down > 0) parts.push(`👎 ${down}`);
  return parts.join(" · ");
}
