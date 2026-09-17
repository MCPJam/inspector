/**
 * The producer's own output, rendered by this repo's types.
 *
 * `PlatformEvalIterationReport` is hand-mirrored from the backend query that
 * fills it. This file is the backend's committed fixture, copied byte for byte
 * (`check:mirrors` pair `eval-iteration-report-wire` holds the two together),
 * so a field that changes shape on one side fails here rather than in a
 * drawer.
 */
import { describe, expect, it } from "vitest";
import type { PlatformEvalIterationReport } from "@mcpjam/sdk/platform";
import { reportAvailability } from "../case-scorecard/report-availability";
import wire from "./fixtures/iteration-report-wire.json";

const states = wire as unknown as Record<string, PlatformEvalIterationReport>;

describe("the iteration report wire", () => {
  it("type-checks every state the producer can send", () => {
    // The annotation is the assertion: a status, reason or field the SDK type
    // does not admit is a compile error in this file.
    const typed: PlatformEvalIterationReport[] = [
      states.ready,
      states.failed,
      states.pending,
    ];
    expect(typed.map((report) => report.status)).toEqual([
      "ready",
      "failed",
      "pending",
    ]);
    expect(typed.every((report) => report.schemaVersion === 1)).toBe(true);
  });

  it("carries the row the drawer renders", () => {
    expect(states.ready.rows[0]).toMatchObject({
      joinKey: "judge:goalCompletion",
      stage: "userValue",
      verdictSeen: "failed",
    });
    expect(states.ready.rows[0]?.citations.length).toBeGreaterThan(0);
  });

  it("turns each state into a line a reader can act on", () => {
    expect(
      reportAvailability(states.ready, { runSettled: true }),
    ).toMatchObject({ kind: "ready" });
    expect(
      reportAvailability(states.failed, { runSettled: true }),
    ).toMatchObject({
      kind: "unavailable",
      line: "This iteration's recorded failures were too large to analyze together.",
    });
    expect(
      reportAvailability(states.pending, { runSettled: true }),
    ).toMatchObject({ kind: "pending", line: "Reading iterations 1 of 2…" });
  });

  it("says nothing about AI while the iteration is still running", () => {
    // An iteration mid-run is not missing an explanation; the scorecard's own
    // in-progress state covers it, and two notices would contradict.
    expect(reportAvailability(null, { runSettled: false })).toMatchObject({
      kind: "ready",
    });
    expect(reportAvailability(null, { runSettled: true })).toMatchObject({
      kind: "none",
      line: "Analyze this run to add AI explanations to these rows.",
    });
  });

  it("labels a reason a newer server invents, rather than blanking", () => {
    // The producer narrows anything it does not know to `analysis_unavailable`,
    // so this is belt and braces — but a blank line is the one outcome a
    // reader cannot act on.
    expect(
      reportAvailability(
        {
          ...states.failed,
          reason:
            "something_a_later_build_wrote" as PlatformEvalIterationReport["reason"],
        },
        { runSettled: true },
      ),
    ).toMatchObject({ kind: "unavailable" });
  });
});
