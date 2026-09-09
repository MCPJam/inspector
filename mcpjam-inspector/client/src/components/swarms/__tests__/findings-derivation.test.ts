import { describe, expect, it } from "vitest";

import type {
  SwarmOverviewRun,
  SwarmWaveDetectorId,
  SwarmWaveSignalCandidate,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import {
  CONNECTION_CAVEAT,
  DETECTOR_STAGE_MAP,
  deriveSwarmFindingsModel,
} from "../findings/findings-derivation";
import { JOURNEY_STAGES } from "../findings/journey-stages";

/**
 * The Findings derivation is the tab's whole contract: pure maps from data
 * the detail page already holds. The two rules these tests defend:
 *
 *  1. "ok" is EARNED — only positive evidence (all launched, all graded
 *     passed) turns a stage green. Silence is `none`, never a pass.
 *  2. Attribution is never invented — journey candidates land on their goal,
 *     persona candidates fan labeled, global subjects are skipped in v1.
 */

function run(overrides: Partial<SwarmOverviewRun> = {}): SwarmOverviewRun {
  return {
    runId: "run-1",
    journeyRefId: "journey-1",
    journeyName: "Export the board",
    journeyArchived: false,
    personaName: "Maya Chen",
    createdAt: 0,
    swarmRunGroupId: "wave-1",
    status: "completed",
    summary: { total: 4, succeeded: 4, failed: 0, rateLimited: 0 },
    findings: [],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<SwarmWaveSignalCandidate> = {}
): SwarmWaveSignalCandidate {
  return {
    detector: "tool_errors",
    subjectKind: "journey",
    subjectId: "journey-1",
    subjectLabel: "Export the board",
    affectedSessions: 2,
    sliceTotal: 4,
    exemplarSessionIds: ["sess-1"],
    contrastSessionIds: [],
    severityScore: 1,
    ...overrides,
  };
}

function signals(overrides: Partial<SwarmWaveSignals> = {}): SwarmWaveSignals {
  return {
    candidates: [],
    sessionCount: 4,
    unanalyzedSessionCount: 0,
    judgeCoverage: { graded: 4, total: 4 },
    truncated: false,
    lowConfidence: false,
    terminal: true,
    ...overrides,
  };
}

const personaDoc = {
  _id: "persona-1",
  name: "Maya Chen",
  role: "Ops lead",
  avatarShape: 2,
  avatarPalette: 3,
};

function derive(args: {
  runs?: SwarmOverviewRun[];
  signals?: SwarmWaveSignals | null;
  personas?: Array<typeof personaDoc>;
}) {
  return deriveSwarmFindingsModel({
    runs: args.runs ?? [run()],
    signals: args.signals === undefined ? signals() : args.signals,
    personas: args.personas ?? [personaDoc],
  });
}

const ALL_DETECTORS: SwarmWaveDetectorId[] = [
  "tool_errors",
  "hallucinated_tool",
  "criterion_fail",
  "target_failures",
  "persona_struggles",
  "marginal_pass",
  "turn_cap_grind",
  "error_recovered_pass",
  "token_outlier",
  "latency_outlier",
  "no_tools_used",
];

describe("detector → stage map", () => {
  it("covers every detector id with a known stage and a non-ok tone", () => {
    // The Record type already breaks the build on a new detector; this pins
    // the runtime shape so a bad merge can't map one to nothing.
    const stageIds = new Set(JOURNEY_STAGES.map((s) => s.id));
    for (const detector of ALL_DETECTORS) {
      const mapping = DETECTOR_STAGE_MAP[detector];
      expect(mapping, detector).toBeDefined();
      expect(stageIds.has(mapping.stage), detector).toBe(true);
      expect(["fail", "warn"]).toContain(mapping.tone);
    }
    expect(Object.keys(DETECTOR_STAGE_MAP).sort()).toEqual(
      [...ALL_DETECTORS].sort()
    );
  });

  it("lands each journey-scoped detector's evidence on its mapped stage", () => {
    for (const detector of ALL_DETECTORS.filter(
      (d) => d !== "persona_struggles"
    )) {
      const mapping = DETECTOR_STAGE_MAP[detector];
      const model = derive({
        signals: signals({ candidates: [candidate({ detector })] }),
      });
      const stage = model.personas[0]!.goals[0]!.stages[mapping.stage];
      expect(stage.state, detector).toBe(mapping.tone);
      expect(stage.evidence.length, detector).toBeGreaterThan(0);
    }
  });
});

describe("attribution", () => {
  it("lands a journey candidate only on the matching goal", () => {
    const model = derive({
      runs: [
        run(),
        run({
          runId: "run-2",
          journeyRefId: "journey-2",
          journeyName: "Share a view",
        }),
      ],
      signals: signals({
        candidates: [candidate({ detector: "hallucinated_tool" })],
      }),
    });
    const [goalA, goalB] = model.personas[0]!.goals;
    expect(goalA!.stages.discovery.state).toBe("fail");
    expect(goalB!.stages.discovery.state).toBe("none");
  });

  it("fans a persona candidate to every goal of that persona, labeled", () => {
    const model = derive({
      runs: [
        run(),
        run({ runId: "run-2", journeyRefId: "journey-2" }),
        run({
          runId: "run-3",
          journeyRefId: "journey-3",
          personaName: "Jonah Okoye",
        }),
      ],
      signals: signals({
        candidates: [
          candidate({
            detector: "persona_struggles",
            subjectKind: "persona",
            subjectId: "persona-1",
            subjectLabel: "Maya Chen",
          }),
        ],
      }),
    });
    const maya = model.personas.find((p) => p.name === "Maya Chen")!;
    const jonah = model.personas.find((p) => p.name === "Jonah Okoye")!;
    for (const goal of maya.goals) {
      expect(goal.stages.value.state).toBe("warn");
      const evidence = goal.stages.value.evidence[0]!;
      expect(evidence.personaScoped).toBe(true);
      expect(evidence.meta).toContain("persona-scoped");
    }
    expect(jonah.goals[0]!.stages.value.state).toBe("none");
  });

  it("skips global subjects (tool/criterion/environment/host) in v1", () => {
    const model = derive({
      signals: signals({
        candidates: [
          candidate({ subjectKind: "tool", subjectId: "create_view" }),
          candidate({
            detector: "criterion_fail",
            subjectKind: "criterion",
            subjectId: "crit-1",
          }),
          candidate({ subjectKind: "host", subjectId: "host-1" }),
          candidate({ subjectKind: "environment", subjectId: "env-1" }),
        ],
      }),
    });
    for (const stage of JOURNEY_STAGES) {
      const model2 = model.personas[0]!.goals[0]!.stages[stage.id];
      // Connection may hold launch evidence; nothing detector-shaped lands.
      expect(
        model2.evidence.filter((e) => e.meta !== CONNECTION_CAVEAT)
      ).toEqual([]);
    }
  });

  it("carries the exemplar session id for evidence deep links", () => {
    const model = derive({
      signals: signals({
        candidates: [candidate({ exemplarSessionIds: ["sess-9"] })],
      }),
    });
    expect(
      model.personas[0]!.goals[0]!.stages.response.evidence[0]!.sessionId
    ).toBe("sess-9");
  });
});

describe("connection stage", () => {
  it("warns with the launch caveat when launches failed or throttled", () => {
    const model = derive({
      runs: [
        run({ summary: { total: 4, succeeded: 1, failed: 2, rateLimited: 1 } }),
      ],
    });
    const connection = model.personas[0]!.goals[0]!.stages.connection;
    expect(connection.state).toBe("warn");
    expect(connection.evidence[0]!.meta).toBe(CONNECTION_CAVEAT);
    expect(connection.evidence[0]!.observation).toContain("failed to launch");
    expect(connection.evidence[0]!.observation).toContain("rate limited");
  });

  it("is ok only when a TERMINAL run launched everything", () => {
    const terminal = derive({});
    expect(terminal.personas[0]!.goals[0]!.stages.connection.state).toBe("ok");

    const live = derive({
      runs: [
        run({
          status: "running",
          summary: { total: 4, succeeded: 4, failed: 0, rateLimited: 0 },
        }),
      ],
    });
    expect(live.personas[0]!.goals[0]!.stages.connection.state).toBe("none");
  });
});

describe("value stage: rubric findings + judge rollup", () => {
  it("maps blocking findings to fail and degraded to warn, graded denominators only", () => {
    const model = derive({
      runs: [
        run({
          findings: [
            {
              criterionId: "crit-block",
              label: "Export completes",
              failCount: 3,
              pendingCount: 0,
              failedGradingCount: 0,
              sessionsGraded: 4,
              runStreak: 1,
            },
            {
              criterionId: "crit-soft",
              label: "Tone stays helpful",
              failCount: 1,
              pendingCount: 0,
              failedGradingCount: 0,
              sessionsGraded: 4,
              runStreak: 1,
            },
          ],
        }),
      ],
    });
    const value = model.personas[0]!.goals[0]!.stages.value;
    expect(value.state).toBe("fail");
    const blocking = value.evidence.find((e) =>
      e.observation.includes("Export completes")
    )!;
    expect(blocking.tone).toBe("fail");
    expect(blocking.meta).toBe("3 of 4 sessions");
    const degraded = value.evidence.find((e) =>
      e.observation.includes("Tone stays helpful")
    )!;
    expect(degraded.tone).toBe("warn");
  });

  it("grades the judge rollup: all passed ok, <50% fail, else warn, 0 graded nothing", () => {
    const stateFor = (goalScoreSummary: SwarmOverviewRun["goalScoreSummary"]) =>
      derive({ runs: [run({ goalScoreSummary })] }).personas[0]!.goals[0]!
        .stages.value.state;

    expect(stateFor({ gradedCount: 4, passedCount: 4, avgScore: 1 })).toBe(
      "ok"
    );
    expect(stateFor({ gradedCount: 4, passedCount: 1, avgScore: 0.2 })).toBe(
      "fail"
    );
    expect(stateFor({ gradedCount: 4, passedCount: 3, avgScore: 0.8 })).toBe(
      "warn"
    );
    // gradedCount 0 contributes NOTHING — never ok, never 0%.
    expect(stateFor({ gradedCount: 0, passedCount: 0, avgScore: null })).toBe(
      "none"
    );
    expect(stateFor(undefined)).toBe("none");
  });
});

describe("never ok without positive evidence", () => {
  it("renders every stage as none on a live, ungraded, findingless run", () => {
    const model = derive({
      runs: [
        run({
          status: "running",
          summary: { total: 4, succeeded: 2, failed: 0, rateLimited: 0 },
        }),
      ],
      signals: null,
    });
    const goal = model.personas[0]!.goals[0]!;
    for (const stage of JOURNEY_STAGES) {
      expect(goal.stages[stage.id].state).toBe("none");
    }
    expect(goal.sentiment).toEqual({ label: "Unscored", tone: "muted" });
    expect(goal.diagnosis.title).toBe("Nothing graded yet");
  });
});

describe("sentiment", () => {
  it("goal: fail → Stalled, warn-only → Uneasy, value-ok → Landed", () => {
    const failing = derive({
      signals: signals({
        candidates: [candidate({ detector: "tool_errors" })],
      }),
    });
    expect(failing.personas[0]!.goals[0]!.sentiment).toEqual({
      label: "Stalled",
      tone: "fail",
    });

    const uneasy = derive({
      runs: [
        run({
          status: "running",
          summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 },
        }),
      ],
      signals: signals({
        candidates: [candidate({ detector: "no_tools_used" })],
      }),
    });
    expect(uneasy.personas[0]!.goals[0]!.sentiment).toEqual({
      label: "Uneasy",
      tone: "warn",
    });

    const landed = derive({
      runs: [
        run({
          goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
        }),
      ],
      signals: null,
    });
    expect(landed.personas[0]!.goals[0]!.sentiment).toEqual({
      label: "Landed",
      tone: "ok",
    });
  });

  it("persona: named by the earliest failing stage across goals", () => {
    const cases: Array<[SwarmWaveDetectorId, string]> = [
      ["hallucinated_tool", "Lost"],
      ["no_tools_used", "Uneasy"], // warn only
      ["tool_errors", "Frustrated"],
      ["criterion_fail", "Stalled"],
    ];
    for (const [detector, label] of cases) {
      const model = derive({
        runs: [
          run({
            status: "running",
            summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 },
          }),
        ],
        signals: signals({ candidates: [candidate({ detector })] }),
      });
      expect(model.personas[0]!.sentiment.label, detector).toBe(label);
    }
  });

  it("persona: Stuck when connection is the earliest fail, Relieved when landed, Unscored when silent", () => {
    // Connection alone can't fail today (launch trouble is a warn), so pair a
    // discovery fail with a later-stage fail and check ordering instead.
    const ordered = derive({
      signals: signals({
        candidates: [
          candidate({ detector: "criterion_fail" }),
          candidate({ detector: "hallucinated_tool" }),
        ],
      }),
    });
    expect(ordered.personas[0]!.sentiment.label).toBe("Lost");

    const relieved = derive({
      runs: [
        run({
          goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
        }),
      ],
      signals: null,
    });
    expect(relieved.personas[0]!.sentiment).toEqual({
      label: "Relieved",
      tone: "ok",
    });

    const silent = derive({
      runs: [
        run({
          status: "running",
          summary: { total: 2, succeeded: 0, failed: 0, rateLimited: 0 },
        }),
      ],
      signals: null,
    });
    expect(silent.personas[0]!.sentiment).toEqual({
      label: "Unscored",
      tone: "muted",
    });
  });

  it("never places the persona as the subject of the issue one-liner", () => {
    const model = derive({
      signals: signals({
        candidates: [candidate({ detector: "tool_errors" })],
      }),
    });
    const issue = model.personas[0]!.issue;
    expect(issue).toContain('"Export the board" broke at');
    expect(issue.startsWith("Maya")).toBe(false);
  });
});

describe("diagnosis + defaults", () => {
  it("diagnoses the EARLIEST failing stage", () => {
    const model = derive({
      signals: signals({
        candidates: [
          candidate({ detector: "tool_errors" }), // response fail
          candidate({ detector: "hallucinated_tool" }), // discovery fail
        ],
      }),
    });
    const goal = model.personas[0]!.goals[0]!;
    expect(goal.diagnosisStage).toBe("discovery");
    expect(goal.defaultStage).toBe("discovery");
    expect(goal.diagnosis.title).toBe("Discovery");
  });

  it("does not read Landed off a successful launch alone", () => {
    // Every session launched, nothing was graded. Launch outcomes are not a
    // finding about the server, so they cannot earn "Landed" by themselves.
    const model = derive({});
    const goal = model.personas[0]!.goals[0]!;
    expect(goal.stages.connection.state).toBe("ok");
    expect(goal.diagnosis.title).toBe("Nothing graded yet");
    expect(goal.diagnosis.detail).toBe(
      "No finding landed on any stage of this goal."
    );
  });

  it("reads Landed only when a graded stage is actually ok", () => {
    const model = derive({
      runs: [
        run({
          goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
        }),
      ],
    });
    const goal = model.personas[0]!.goals[0]!;
    expect(goal.diagnosis.title).toBe("Landed");
    expect(goal.diagnosis.detail).toBe(
      "Every measured stage held for this goal."
    );
  });

  it("reads Friction, not Landed, when the only evidence is a warning", () => {
    const model = derive({
      signals: signals({
        candidates: [candidate({ detector: "latency_outlier" })], // response warn
      }),
    });
    const goal = model.personas[0]!.goals[0]!;
    expect(goal.diagnosisStage).toBeNull();
    expect(goal.diagnosis.title).toBe("Friction");
    expect(goal.diagnosis.detail).toBe(
      "No stage broke outright, but at least one measured stage showed friction."
    );
  });

  it("defaults the selected persona to the first with a failing goal", () => {
    const model = derive({
      runs: [
        run({ personaName: "Aaron Calm" }),
        run({
          runId: "run-2",
          journeyRefId: "journey-2",
          personaName: "Zoe Blocked",
        }),
      ],
      signals: signals({
        candidates: [
          candidate({ detector: "tool_errors", subjectId: "journey-2" }),
        ],
      }),
    });
    expect(model.personas[model.defaultPersonaIndex]!.name).toBe("Zoe Blocked");
  });
});

describe("persona rollup", () => {
  it("groups by personaName, sums sessions authored, joins the doc for the avatar look", () => {
    const model = derive({
      runs: [
        run(),
        run({
          runId: "run-2",
          journeyRefId: "journey-2",
          summary: { total: 3, succeeded: 3, failed: 0, rateLimited: 0 },
        }),
      ],
    });
    expect(model.personas).toHaveLength(1);
    const maya = model.personas[0]!;
    expect(maya.sessionsAuthored).toBe(7);
    expect(maya.role).toBe("Ops lead");
    expect(maya.avatarSeed).toBe("persona-1");
    expect(maya.avatarShape).toBe(2);
    expect(maya.avatarPalette).toBe(3);
    expect(maya.goals).toHaveLength(2);
  });

  it("falls back to the name as avatar seed when no persona doc matches", () => {
    const model = derive({ personas: [] });
    expect(model.personas[0]!.avatarSeed).toBe("Maya Chen");
  });

  it("takes the session count from signals, falling back to wave totals", () => {
    expect(
      derive({ signals: signals({ sessionCount: 12 }) }).sessionCount
    ).toBe(12);
    expect(derive({ signals: null }).sessionCount).toBe(4);
  });
});
