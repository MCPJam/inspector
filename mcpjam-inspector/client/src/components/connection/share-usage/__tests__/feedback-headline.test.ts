import { describe, expect, it } from "vitest";

import {
  feedbackHeadline,
  formatThumbCounts,
} from "@/components/connection/share-usage/feedback-headline";

/**
 * How a session announces its feedback, derived from the counts alone.
 *
 * The backend stores no `style` on the summary — deliberately, because a
 * session can hold rows from both widgets after a mid-session style switch and
 * there is no single style to name. These pin the derivation the list row and
 * the detail header share.
 */

const base = { count: 1, avg: 3, min: 3 };

describe("feedbackHeadline", () => {
  it("a star-only session shows its average", () => {
    expect(feedbackHeadline({ ...base, count: 3, avg: 4.5, min: 3 })).toEqual({
      kind: "stars",
      avg: 4.5,
      count: 3,
    });
  });

  it("a thumbs-only session shows tallies, never an average", () => {
    // `/5` on a session where nobody was offered a 5 is a number the tester
    // never gave.
    expect(
      feedbackHeadline({
        count: 3,
        avg: 3.67,
        min: 1,
        thumbUpCount: 2,
        thumbDownCount: 1,
      })
    ).toEqual({ kind: "thumbs", up: 2, down: 1, count: 3 });
  });

  it("a session with both shows the average AND the tallies", () => {
    // Dropping either half would under-report how many turns were judged.
    expect(
      feedbackHeadline({
        count: 3,
        avg: 3,
        min: 1,
        thumbDownCount: 1,
      })
    ).toEqual({ kind: "mixed", avg: 3, count: 3, up: 0, down: 1 });
  });

  it("treats a pre-thumbs summary as stars", () => {
    // Every summary written before thumbs existed lacks both counts.
    expect(feedbackHeadline({ count: 2, avg: 4, min: 3 }).kind).toBe("stars");
  });

  it("a single thumbs-up is thumbs, not a 5-star average", () => {
    expect(
      feedbackHeadline({ count: 1, avg: 5, min: 5, thumbUpCount: 1 })
    ).toEqual({ kind: "thumbs", up: 1, down: 0, count: 1 });
  });
});

describe("formatThumbCounts", () => {
  it("shows both sides when both happened", () => {
    expect(formatThumbCounts(3, 1)).toBe("👍 3 · 👎 1");
  });

  it("drops a zero side rather than printing 👎 0", () => {
    expect(formatThumbCounts(3, 0)).toBe("👍 3");
    expect(formatThumbCounts(0, 2)).toBe("👎 2");
  });
});
