import { describe, expect, it } from "vitest";
import {
  compareThreadsForUsageList,
  threadMatchesChip,
  threadMatchesUsageFilter,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

/**
 * Per-turn ratings reduce to a session's WORST turn, everywhere.
 *
 * These pin the client half of that policy against the backend's
 * `lib/usageInsights/filters.ts`. The two matchers run over the same cohorts —
 * the server filters inside its index walk and the client re-checks live
 * updates — so a disagreement shows up as rows appearing and vanishing.
 */

function thread(
  overrides: Partial<SharedChatThread> & Pick<SharedChatThread, "_id">
): SharedChatThread {
  return {
    sourceType: "chatbox",
    messageCount: 0,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

function summary(
  overrides: Partial<NonNullable<SharedChatThread["feedback"]>>
): NonNullable<SharedChatThread["feedback"]> {
  return {
    count: 1,
    avg: 3,
    min: 3,
    hasComment: false,
    latestRating: 3,
    latestAt: 0,
    ...overrides,
  };
}

describe("worst-turn policy", () => {
  it("low_ratings selects a session whose bad turn is buried under good ones", () => {
    // avg 3.5 — an averaging policy would hide exactly the session a PM
    // opened this filter to find.
    const buriedBadTurn = thread({
      _id: "a",
      feedback: summary({ count: 2, avg: 3.5, min: 2, latestRating: 5 }),
    });
    expect(threadMatchesUsageFilter(buriedBadTurn, "low_ratings")).toBe(true);
  });

  it("low_ratings ignores a session whose worst turn was fine", () => {
    const allGood = thread({
      _id: "a",
      feedback: summary({ count: 3, avg: 4.3, min: 4, latestRating: 4 }),
    });
    expect(threadMatchesUsageFilter(allGood, "low_ratings")).toBe(false);
  });

  it("buckets on the worst turn, not the average", () => {
    const buriedBadTurn = thread({
      _id: "a",
      feedback: summary({ count: 2, avg: 3.5, min: 2, latestRating: 5 }),
    });
    expect(
      threadMatchesChip(buriedBadTurn, {
        kind: "dimension",
        key: "feedbackBucket",
        value: "negative",
      })
    ).toBe(true);
    expect(
      threadMatchesChip(buriedBadTurn, {
        kind: "dimension",
        key: "feedbackBucket",
        value: "positive",
      })
    ).toBe(false);
  });

  it("needs_review catches a 3-star worst turn only when someone wrote something", () => {
    const quiet = thread({
      _id: "a",
      messageCount: 2,
      feedback: summary({ min: 3, hasComment: false }),
    });
    expect(threadMatchesUsageFilter(quiet, "needs_review")).toBe(false);

    // The comment rode on a DIFFERENT turn than the worst one — which is why
    // the summary carries `hasComment` separately from `worstComment`.
    const commented = thread({
      _id: "b",
      messageCount: 2,
      feedback: summary({ min: 3, hasComment: true }),
    });
    expect(threadMatchesUsageFilter(commented, "needs_review")).toBe(true);
  });

  it("no_feedback excludes a session that was rated at all", () => {
    const rated = thread({
      _id: "a",
      feedback: summary({ min: 5, avg: 5, latestRating: 5 }),
    });
    const unrated = thread({ _id: "b" });
    expect(threadMatchesUsageFilter(rated, "no_feedback")).toBe(false);
    expect(threadMatchesUsageFilter(unrated, "no_feedback")).toBe(true);
  });

  it("sorts the buried bad turn ahead of a uniformly good session", () => {
    const buriedBadTurn = thread({
      _id: "a",
      lastActivityAt: 10,
      feedback: summary({ count: 2, avg: 3.5, min: 2, latestRating: 5 }),
    });
    const allGood = thread({
      _id: "b",
      lastActivityAt: 999,
      feedback: summary({ count: 2, avg: 5, min: 5, latestRating: 5 }),
    });
    expect(compareThreadsForUsageList(buriedBadTurn, allGood)).toBeLessThan(0);
  });

  it("falls back to the flat fields for a row from an older backend", () => {
    // The backend maps `feedbackRating` from the same `min`, so both paths
    // agree — but a client running ahead of a deploy still has to work.
    const legacy = thread({ _id: "a", feedbackRating: 2 });
    expect(threadMatchesUsageFilter(legacy, "low_ratings")).toBe(true);
    expect(
      threadMatchesChip(legacy, {
        kind: "dimension",
        key: "feedbackBucket",
        value: "negative",
      })
    ).toBe(true);
  });
});

describe("a thumbs-rated session needs no client-side filter branch", () => {
  // SCOPE, stated plainly: the projection itself (down ⇒ 1, up ⇒ 5) happens
  // server-side in `SUMMARY_VALUE_MAP` and is pinned in the backend's
  // `sessionScores.test.ts`. The fixtures below therefore set `min` by hand,
  // exactly as the backend would have written it, and a broken projection
  // would be caught there rather than here.
  //
  // What these pin is the client half: given a summary carrying thumb
  // tallies, every matcher still reads `min` and NONE of them grows a special
  // case. That is the claim that would silently rot if someone "fixed" the
  // filters to branch on `thumbUpCount`/`thumbDownCount`.

  it("a summary carrying a down-thumb matches Low (≤2) through min alone", () => {
    const thumbedDown = thread({
      _id: "a",
      feedback: summary({
        count: 2,
        avg: 3,
        min: 1,
        latestRating: 5,
        thumbUpCount: 1,
        thumbDownCount: 1,
      }),
    });
    expect(threadMatchesUsageFilter(thumbedDown, "low_ratings")).toBe(true);
    expect(
      threadMatchesChip(thumbedDown, {
        kind: "dimension",
        key: "feedbackBucket",
        value: "negative",
      })
    ).toBe(true);
  });

  it("an up-thumbs-only summary does not, and buckets positive", () => {
    const thumbedUp = thread({
      _id: "a",
      feedback: summary({
        count: 2,
        avg: 5,
        min: 5,
        latestRating: 5,
        thumbUpCount: 2,
      }),
    });
    expect(threadMatchesUsageFilter(thumbedUp, "low_ratings")).toBe(false);
    expect(
      threadMatchesChip(thumbedUp, {
        kind: "dimension",
        key: "feedbackBucket",
        value: "positive",
      })
    ).toBe(true);
  });

  it("no projected thumb value can land in the neutral bucket", () => {
    // A documented dead option, not a bug: a two-state control has no neutral
    // to express, so no projection can land on 3.
    const thumbedDown = thread({
      _id: "a",
      feedback: summary({
        count: 1,
        avg: 1,
        min: 1,
        latestRating: 1,
        thumbDownCount: 1,
      }),
    });
    expect(
      threadMatchesChip(thumbedDown, {
        kind: "dimension",
        key: "feedbackBucket",
        value: "neutral",
      })
    ).toBe(false);
  });

  it("a mixed-style summary is judged by min, whatever wrote that turn", () => {
    // One star row (4) and one thumbs-down (⇒ 1) — the complaint wins.
    const mixed = thread({
      _id: "a",
      feedback: summary({
        count: 2,
        avg: 2.5,
        min: 1,
        latestRating: 4,
        thumbDownCount: 1,
      }),
    });
    expect(threadMatchesUsageFilter(mixed, "low_ratings")).toBe(true);
  });
});
