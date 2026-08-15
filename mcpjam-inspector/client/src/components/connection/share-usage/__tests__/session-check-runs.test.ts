/**
 * Classifying `chatSessionChecks` rows.
 *
 * `chatSessionChecks` is a shared table: the deterministic checks evaluator
 * and the LLM judge both write to it, and `source` does NOT separate them
 * (both write `on_demand`; the judge also writes `scheduled`). Getting this
 * wrong renders judge rows as empty duplicate "Checks" groups on the session
 * detail — which is what a presence-based rule (`goalCompletionResult` is
 * set ⇒ judge) does to every judge row that failed or is still running.
 */

import { describe, expect, it } from "vitest";
import {
  checkRunOriginLabel,
  classifyCheckRun,
  sortCheckRunsNewestFirst,
  toCheckVerdicts,
  type SessionCheckRun,
} from "../session-check-runs";

describe("classifyCheckRun", () => {
  it("trusts an explicit runKind over every heuristic", () => {
    // A judge-shaped id AND a judge-shaped snapshot, stamped `checks`. The
    // column is written by the producer itself, so it outranks any guess made
    // from the row's shape.
    expect(
      classifyCheckRun({
        runKind: "checks",
        checkRunId: "swarm_judge:s1:gen-1",
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
      })
    ).toBe("checks");

    expect(
      classifyCheckRun({
        runKind: "judge",
        checkRunId: "swarmchecks:s1",
      })
    ).toBe("judge");
  });

  it("falls back to the producer-minted id shape on legacy rows", () => {
    // The backstage/prod promotion gap: the panel ships before the backend
    // column does, and these rows must still classify correctly.
    expect(classifyCheckRun({ checkRunId: "swarmchecks:s1" })).toBe("checks");
    expect(classifyCheckRun({ checkRunId: "swarm_judge:s1:sched:a1" })).toBe(
      "judge"
    );
    expect(
      classifyCheckRun({ checkRunId: "s1_on_demand_judge_1717171717" })
    ).toBe("judge");
  });

  it("classifies a FAILED legacy judge row as judge, not as empty checks", () => {
    // No `goalCompletionResult` on a failed run — the exact row a
    // presence-based rule misfiles into a phantom checks group.
    expect(
      classifyCheckRun({
        checkRunId: "s1_on_demand_judge_1717171717",
        source: "on_demand",
        status: "failed",
        error: "missing_api_key",
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
      })
    ).toBe("judge");
  });

  it("classifies a RUNNING legacy judge row as judge", () => {
    expect(
      classifyCheckRun({
        checkRunId: "swarm_judge:s1:sched:a1",
        status: "running",
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
      })
    ).toBe("judge");
  });

  it("uses snapshot shape only when no id rule matched", () => {
    // Empty ad_hoc snapshot with an unrecognizable id ⇒ judge.
    expect(
      classifyCheckRun({
        checkRunId: "some-legacy-id",
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
      })
    ).toBe("judge");
    // Carries predicates ⇒ a checks run.
    expect(
      classifyCheckRun({
        checkRunId: "some-legacy-id",
        definitionSnapshot: {
          setKind: "case_resolved",
          predicates: [{ type: "noToolErrors" }],
        },
      })
    ).toBe("checks");
    // Carries a rubric, even an empty one: `criteria` present at all is a
    // shape only the rubric path writes.
    expect(
      classifyCheckRun({
        checkRunId: "some-legacy-id",
        definitionSnapshot: {
          setKind: "journey_rubric",
          predicates: [],
          criteria: [],
        },
      })
    ).toBe("checks");
  });
});

describe("sortCheckRunsNewestFirst", () => {
  it("puts the newest run first and does not mutate the input", () => {
    const rows: SessionCheckRun[] = [
      { checkRunId: "a", createdAt: 100 },
      { checkRunId: "b", createdAt: 300 },
      { checkRunId: "c", createdAt: 200 },
    ];
    expect(sortCheckRunsNewestFirst(rows).map((r) => r.checkRunId)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(rows.map((r) => r.checkRunId)).toEqual(["a", "b", "c"]);
  });

  it("backstops a row with no createdAt on Convex's own _creationTime", () => {
    const rows: SessionCheckRun[] = [
      { checkRunId: "a", _creationTime: 500 },
      { checkRunId: "b", createdAt: 100 },
    ];
    expect(sortCheckRunsNewestFirst(rows).map((r) => r.checkRunId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("toCheckVerdicts", () => {
  it("names rubric results from the pinned snapshot, author label first", () => {
    const verdicts = toCheckVerdicts({
      definitionSnapshot: {
        setKind: "journey_rubric",
        predicates: [],
        criteria: [
          {
            id: "crit-1",
            label: "Finds the refund",
            predicate: { type: "toolCalledAtLeastOnce", toolName: "refund" },
          },
          {
            id: "crit-2",
            predicate: { type: "toolCalledAtLeastOnce", toolName: "search" },
          },
        ],
      },
      criterionResults: [
        { criterionId: "crit-1", passed: true, reason: 'called "refund" 1x' },
        {
          criterionId: "crit-2",
          passed: false,
          reason: 'tool "search" was never called',
        },
      ],
    });

    expect(verdicts).toEqual([
      {
        key: "0-crit-1",
        name: "Finds the refund",
        passed: true,
        reason: 'called "refund" 1x',
      },
      {
        key: "1-crit-2",
        // No author label ⇒ the formatted predicate, argument inlined.
        name: "Tool was called at least once search",
        passed: false,
        reason: 'tool "search" was never called',
      },
    ]);
  });

  it("keeps the author's label even when the snapshot entry has no predicate", () => {
    // The label is the one human-written name available. Consulting the
    // predicate first and bailing to the raw id would discard it.
    const verdicts = toCheckVerdicts({
      definitionSnapshot: {
        setKind: "journey_rubric",
        predicates: [],
        criteria: [{ id: "crit-1", label: "Finds the refund" }],
      },
      criterionResults: [
        { criterionId: "crit-1", passed: false, reason: "did not hold" },
      ],
    });
    expect(verdicts[0].name).toBe("Finds the refund");
  });

  it("names an unknown predicate kind by its raw type, never a prototype object", () => {
    // `PREDICATE_KIND_LABELS["__proto__"]` resolves through the prototype
    // chain to an object, which survives `??`/`||` and then throws when React
    // renders it. Wire data is untrusted, so this must degrade to text.
    const verdicts = toCheckVerdicts({
      predicateResults: [
        {
          predicate: { type: "__proto__" } as never,
          passed: false,
          reason: "irrelevant",
        },
      ],
    });
    expect(verdicts[0].name).toBe("__proto__");
  });

  it("falls back to the raw id when the check left the snapshot", () => {
    // A real verdict with a real reason whose check the rubric no longer
    // defines. Naming it by id is honest; inventing a friendly name is a guess.
    const verdicts = toCheckVerdicts({
      definitionSnapshot: { setKind: "journey_rubric", predicates: [], criteria: [] },
      criterionResults: [
        { criterionId: "crit-orphan", passed: false, reason: "did not hold" },
      ],
    });
    expect(verdicts).toEqual([
      {
        key: "0-crit-orphan",
        name: "crit-orphan",
        passed: false,
        reason: "did not hold",
      },
    ]);
  });

  it("handles the suite-shaped predicateResults path", () => {
    const verdicts = toCheckVerdicts({
      definitionSnapshot: {
        setKind: "case_resolved",
        predicates: [{ type: "noToolErrors" }],
      },
      predicateResults: [
        {
          predicate: { type: "noToolErrors" },
          passed: true,
          reason: "no tool errors",
        },
      ],
    });
    expect(verdicts).toEqual([
      {
        key: "predicate-0",
        name: "No tool errors",
        passed: true,
        reason: "no tool errors",
      },
    ]);
  });

  it("falls through to predicateResults when criterionResults is present but empty", () => {
    // Gating on `Array.isArray` alone would claim the rubric branch here and
    // report a completed run as having no verdicts at all.
    const verdicts = toCheckVerdicts({
      criterionResults: [],
      predicateResults: [
        {
          predicate: { type: "noToolErrors" },
          passed: true,
          reason: "no tool errors",
        },
      ],
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].name).toBe("No tool errors");
  });

  it("yields nothing for a run with no results yet", () => {
    expect(toCheckVerdicts({ status: "running" })).toEqual([]);
    expect(toCheckVerdicts({ status: "failed", error: "boom" })).toEqual([]);
  });

  it("skips malformed rows rather than rendering undefined verdicts", () => {
    const verdicts = toCheckVerdicts({
      criterionResults: [
        { criterionId: "ok", passed: true, reason: "held" },
        // No `passed` — the one field the whole row is about.
        { criterionId: "broken", reason: "???" },
      ],
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].key).toBe("0-ok");
  });
});

describe("checkRunOriginLabel", () => {
  it("names the known triggers", () => {
    expect(checkRunOriginLabel({ source: "swarm" })).toBe("Swarm");
    expect(checkRunOriginLabel({ source: "on_demand" })).toBe("On demand");
  });

  it("passes through a source this build predates", () => {
    // WS1's production scoring writes `production`; a build shipped before it
    // must show the row, not drop or crash on it.
    expect(checkRunOriginLabel({ source: "production" })).toBe("Production");
    expect(checkRunOriginLabel({ source: "future_thing" })).toBe("future_thing");
    expect(checkRunOriginLabel({})).toBe("Unknown");
  });
});
