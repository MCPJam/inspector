import { describe, expect, it } from "vitest";
import { toServerFilters } from "@/hooks/useUsageInsights";
import type { UsageFilterState } from "@/hooks/chatbox-usage-filters";

/**
 * The serialization boundary between the client's filter state and the Convex
 * query. Everything the server needs to reproduce a cohort has to survive this
 * function; anything dropped here fails silently, because the query still runs
 * and still returns rows — just the wrong ones.
 */
describe("toServerFilters", () => {
  it("keeps a theme chip's axis", () => {
    // Cluster ids are globally unique, so the axis is not needed to FIND the
    // theme — it tells the server which of the session's four theme fields to
    // compare. Dropped, every non-goal selection reads as a goal cluster and
    // comes back empty or unrelated.
    const state: UsageFilterState = {
      preset: "all",
      chips: [
        { kind: "cluster", clusterId: "s-1", dimension: "sentiment" },
        { kind: "cluster", clusterId: "b-1", dimension: "behavior" },
      ],
    };
    expect(toServerFilters(state).chips).toEqual([
      { kind: "cluster", clusterId: "s-1", dimension: "sentiment" },
      { kind: "cluster", clusterId: "b-1", dimension: "behavior" },
    ]);
  });

  it("omits the axis entirely for a goal chip rather than sending a default", () => {
    // The topic map writes chips with no dimension, and the server reads
    // absence as `goal`. Sending an explicit `goal` would be equivalent, but
    // omitting keeps the wire shape identical to what older clients send.
    expect(
      toServerFilters({
        preset: "all",
        chips: [{ kind: "cluster", clusterId: "g-1" }],
      }).chips,
    ).toEqual([{ kind: "cluster", clusterId: "g-1" }]);
  });

  it("drops the render-only label", () => {
    // `label` exists to render a dismiss button; the server has no use for it.
    expect(
      toServerFilters({
        preset: "all",
        chips: [
          { kind: "cluster", clusterId: "g-1", dimension: "goal", label: "X" },
        ],
      }).chips,
    ).toEqual([{ kind: "cluster", clusterId: "g-1", dimension: "goal" }]);
  });

  it("passes dimension chips and the preset through", () => {
    const state: UsageFilterState = {
      preset: "needs_review",
      chips: [{ kind: "dimension", key: "outcome", value: "errored" }],
    };
    expect(toServerFilters(state)).toEqual({
      preset: "needs_review",
      chips: [{ kind: "dimension", key: "outcome", value: "errored" }],
    });
  });
});
