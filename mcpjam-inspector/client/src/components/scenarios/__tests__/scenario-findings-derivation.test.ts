import { describe, expect, it } from "vitest";

import {
  deriveScenarioFindingsFootnotes,
  deriveScenarioFindingsModel,
  type ScenarioFindingsSession,
} from "../findings/scenario-findings-derivation";
import { JOURNEY_STAGES } from "@/components/swarms/findings/journey-stages";

/**
 * A User Testing persona is the closed five-value `sentiment`, worst first, and
 * only where sessions actually exist. The rules that matter are the honest
 * ones: an unanalyzed session is not an "unclear" user, an unclustered session
 * still counts toward its persona, and no stage is ever reported as passing on
 * a surface that has not measured stages per goal.
 */

function session(
  overrides: Partial<ScenarioFindingsSession> = {}
): ScenarioFindingsSession {
  return {
    _id: "sess-1",
    sentiment: "neutral",
    themeClusterId: "goal-1",
    themeClusterLabel: "Find what the server can do",
    outcome: "completed",
    ...overrides,
  };
}

describe("deriveScenarioFindingsModel", () => {
  it("groups sessions into sentiment personas, worst first", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [
        session({ _id: "a", sentiment: "satisfied" }),
        session({ _id: "b", sentiment: "frustrated" }),
        session({ _id: "c", sentiment: "gave_up" }),
        session({ _id: "d", sentiment: "neutral" }),
      ],
    });

    expect(model.personas.map((p) => p.name)).toEqual([
      "Gave up",
      "Frustrated users",
      "Neutral users",
      "Satisfied users",
    ]);
    // The default tab is the one worth reading, not the alphabetical first.
    expect(model.personas[model.defaultPersonaIndex]!.name).toBe("Gave up");
  });

  it("renders no tab for a sentiment nobody expressed", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [session({ sentiment: "satisfied" })],
    });

    // `gave_up` requires the user to say it in words, so most studies have
    // none. An empty tab would be worse than no tab.
    expect(model.personas).toHaveLength(1);
    expect(model.personas.map((p) => p.name)).not.toContain("Gave up");
  });

  it("counts an unanalyzed session separately instead of calling it unclear", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [
        session({ _id: "a", sentiment: undefined }),
        session({ _id: "b", sentiment: undefined }),
        session({ _id: "c", sentiment: "unclear" }),
      ],
    });

    // Absence is not a verdict. `unclear` means the model looked and could not
    // tell; absent means nobody has looked.
    expect(model.unanalyzedCount).toBe(2);
    const uncategorized = model.personas.find(
      (p) => p.name === "Uncategorized users"
    );
    expect(uncategorized?.sessionsAuthored).toBe(1);
  });

  it("builds goals from theme clusters, most-used first", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [
        session({ _id: "a", themeClusterId: "g1", themeClusterLabel: "Export" }),
        session({ _id: "b", themeClusterId: "g2", themeClusterLabel: "Browse" }),
        session({ _id: "c", themeClusterId: "g2", themeClusterLabel: "Browse" }),
      ],
    });

    const goals = model.personas[0]!.goals;
    expect(goals.map((g) => g.title)).toEqual(["Browse", "Export"]);
    expect(goals[0]!.sessions).toBe(2);
    // The drilldown pages a goal by its cluster id, so that is its identity.
    expect(goals[0]!.runId).toBe("g2");
  });

  it("reads the goal pill from the measured outcome", () => {
    const pillFor = (outcome: ScenarioFindingsSession["outcome"]) =>
      deriveScenarioFindingsModel({
        sessions: [session({ outcome })],
      }).personas[0]!.goals[0]!.sentiment.label;

    expect(pillFor("unresolved")).toBe("Stalled");
    expect(pillFor("errored")).toBe("Stalled");
    expect(pillFor("partial")).toBe("Uneasy");
    expect(pillFor("completed")).toBe("Landed");
    // Nothing measured is not a goal that held.
    expect(pillFor(undefined)).toBe("Unscored");
  });

  it("keeps an unclustered session in its persona without inventing a goal", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [
        session({ _id: "a", themeClusterId: "g1", themeClusterLabel: "Export" }),
        session({ _id: "b", themeClusterId: undefined }),
      ],
    });

    const persona = model.personas[0]!;
    expect(persona.sessionsAuthored).toBe(2);
    // The goal counts sum to less than the persona total, which is the honest
    // reading: one session has no goal yet.
    expect(persona.goals).toHaveLength(1);
    expect(persona.goals[0]!.sessions).toBe(1);
  });

  it("reports the denominator Insights uses, not the rows it was handed", () => {
    // BB-145's first acceptance item: Findings and Insights agree on the count
    // for the same study. The drilldown pages; the breakdown total does not.
    const model = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" }), session({ _id: "b" })],
      sessionCount: 48,
    });
    expect(model.sessionCount).toBe(48);

    const withoutTotal = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" })],
    });
    expect(withoutTotal.sessionCount).toBe(1);
  });

  it("never reports a stage as passing on a surface that has not measured them", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [session({ outcome: "completed" })],
    });
    const goal = model.personas[0]!.goals[0]!;

    for (const stage of JOURNEY_STAGES) {
      expect(goal.stages[stage.id].state).toBe("none");
      expect(goal.stages[stage.id].evidence).toEqual([]);
    }
    expect(goal.diagnosisStage).toBeNull();
  });

  it("blames the experience in the persona aside, never the person", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [
        session({
          sentiment: "frustrated",
          outcome: "unresolved",
          themeClusterLabel: "Export the board",
        }),
      ],
    });

    const persona = model.personas[0]!;
    expect(persona.issue).toBe(
      '"Export the board" did not resolve for these sessions.'
    );
    expect(persona.issue).not.toContain("Frustrated users");
  });

  it("returns nothing to render for a study with no sessions", () => {
    const model = deriveScenarioFindingsModel({ sessions: [] });
    expect(model.personas).toEqual([]);
    expect(model.sessionCount).toBe(0);
    expect(model.unanalyzedCount).toBe(0);
  });
});

/**
 * The grid is tallied from sessions, and the drilldown that supplies them pages
 * against a cap. A partial grid can drop a goal from a persona entirely, so the
 * shortfall is reported rather than absorbed.
 */
describe("coverage", () => {
  it("marks the grid partial when it saw fewer sessions than the study has", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" }), session({ _id: "b" })],
      sessionCount: 900,
    });

    expect(model.coverage).toEqual({
      scanned: 2,
      total: 900,
      truncated: true,
    });
  });

  it("marks the grid complete when it saw the whole study", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" }), session({ _id: "b" })],
      sessionCount: 2,
    });
    expect(model.coverage.truncated).toBe(false);
  });

  it("believes the fetch over the arithmetic when it reports a cap", () => {
    // The drilldown knows it stopped short even when the counts happen to
    // line up, so an explicit `totalTruncated` wins.
    const model = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" })],
      sessionCount: 1,
      truncated: true,
    });
    expect(model.coverage.truncated).toBe(true);
  });
});

describe("deriveScenarioFindingsFootnotes", () => {
  it("says the scan hit its cap, in the words the swarm card already uses", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [session()],
      sessionCount: 900,
    });
    expect(deriveScenarioFindingsFootnotes(model)).toContain(
      "Session scan hit its cap — counts cover a subset"
    );
  });

  it("counts the sessions no persona speaks for", () => {
    const one = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" }), session({ _id: "b", sentiment: undefined })],
      sessionCount: 2,
    });
    expect(deriveScenarioFindingsFootnotes(one)).toContain(
      "1 session not analyzed yet — in no persona above"
    );

    const many = deriveScenarioFindingsModel({
      sessions: [
        session({ _id: "a", sentiment: undefined }),
        session({ _id: "b", sentiment: undefined }),
      ],
      sessionCount: 2,
    });
    expect(deriveScenarioFindingsFootnotes(many)).toContain(
      "2 sessions not analyzed yet — in no persona above"
    );
  });

  it("stays silent on a complete, fully analyzed study", () => {
    const model = deriveScenarioFindingsModel({
      sessions: [session({ _id: "a" }), session({ _id: "b" })],
      sessionCount: 2,
    });
    expect(deriveScenarioFindingsFootnotes(model)).toEqual([]);
  });
});
