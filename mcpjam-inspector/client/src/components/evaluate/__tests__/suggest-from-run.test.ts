/**
 * The engine, and the two rules that keep it honest.
 *
 * A suggestion is a claim about future runs built from past ones. The failure
 * mode is not "we missed one" — it is proposing a REQUIREMENT that hardens
 * whatever the server happened to do, including doing it wrong. So the tests
 * that matter most are the refusals.
 */

import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  goalNeedles,
  heldInEvery,
  suggestScorers,
  type SuggestInput,
} from "../case-scorecard/suggest-from-run";
import type { TrialRunFacts } from "../case-scorecard/trial-run-facts";

const prompt: TestStep = { id: "s1", kind: "prompt", prompt: "Who am I?" };

function facts(over: Partial<TrialRunFacts> = {}): TrialRunFacts {
  const toolSequence = over.toolSequence ?? ["get_me"];
  return {
    iterationId: `it-${Math.random()}`,
    batchKey: "suite:r1",
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    observed: true,
    readState: "full",
    successSignal: "judge",
    toolSequence,
    toolSet: new Set(toolSequence),
    pathKey: toolSequence.join(">"),
    tokensTotal: 1000,
    turnCount: 1,
    finalMessage: "You are marcelo@mcpjam.com",
    toolErrors: [],
    toolErrorsByTurn: new Map(),
    toolsByTurn: new Map([[0, toolSequence]]),
    turnSource: "spans",
    renderedByTool: new Map(),
    clickCalls: [],
    ...over,
  };
}

const input = (over: Partial<SuggestInput> = {}): SuggestInput => ({
  trials: [facts(), facts(), facts()],
  steps: [prompt],
  route: { kind: "checks" },
  ...over,
});

const kinds = (out: ReturnType<typeof suggestScorers>) =>
  out.suggestions.map((s) => s.predicate?.type ?? s.kind);

describe("requirements need demonstrated success", () => {
  it("offers gates when every trial accomplished the goal", () => {
    const out = suggestScorers(input());
    expect(out.diagnosis).toBeNull();
    expect(kinds(out)).toContain("noToolErrors");
    expect(out.suggestions.some((s) => s.role === "gate")).toBe(true);
  });

  it("offers NO gate when one trial did not accomplish the goal", () => {
    // Three runs that all called the wrong tool agree with each other
    // perfectly. Requiring that route would harden the bug.
    const out = suggestScorers(
      input({
        trials: [facts(), facts(), facts({ successSignal: "none" })],
      }),
    );
    expect(out.diagnosis).toMatchObject({
      unsuccessful: 1,
      of: 3,
      noSignal: false,
    });
    expect(out.suggestions.every((s) => s.role !== "gate")).toBe(true);
  });

  it("still reports budgets on a batch that failed — they cost nothing", () => {
    const out = suggestScorers(
      input({ trials: [facts({ successSignal: "none" })] }),
    );
    expect(kinds(out)).toContain("tokenBudgetUnder");
    expect(out.suggestions.every((s) => s.role === "report")).toBe(true);
  });

  it("flags a batch with no success signal at all", () => {
    // An ungraded quick run: nothing establishes that it worked.
    const out = suggestScorers(
      input({
        trials: [
          facts({ successSignal: "none" }),
          facts({ successSignal: "none" }),
        ],
      }),
    );
    expect(out.diagnosis?.noSignal).toBe(true);
  });

  it("accepts a passing gate as a success signal, not just the judge", () => {
    const out = suggestScorers(
      input({
        trials: [
          facts({ successSignal: "gates" }),
          facts({ successSignal: "gates" }),
        ],
      }),
    );
    expect(out.diagnosis).toBeNull();
  });
});

describe("a claim must hold in every trial", () => {
  it("drops a check one trial contradicts", () => {
    const out = suggestScorers(
      input({
        trials: [
          facts(),
          facts({
            toolErrors: [{ kind: "content-error", toolName: "get_me" }],
          }),
        ],
      }),
    );
    expect(kinds(out)).not.toContain("noToolErrors");
  });

  it("treats an unread trace as not held, never as agreement", () => {
    // "No tool errored" and "we never looked" are different claims.
    const out = suggestScorers(
      input({
        trials: [
          facts(),
          facts({
            readState: "failed",
            finalMessage: undefined,
            toolErrors: undefined,
            toolsByTurn: undefined,
            renderedByTool: undefined,
            clickCalls: undefined,
          }),
        ],
      }),
    );
    expect(kinds(out)).not.toContain("noToolErrors");
    // Tier 1 survives — it never needed the blob.
    expect(kinds(out)).toContain("tokenBudgetUnder");
  });

  it("suppresses per-turn claims when the turn split is unreadable", () => {
    const out = suggestScorers(
      input({
        steps: [prompt, { id: "s2", kind: "prompt", prompt: "and my org?" }],
        trials: [
          facts({ toolsByTurn: undefined }),
          facts({ toolsByTurn: undefined }),
        ],
      }),
    );
    expect(kinds(out)).not.toContain("toolCalledAtLeastOnce");
    // The whole-run claim does not depend on the split.
    expect(kinds(out)).toContain("noToolErrors");
  });

  it("counts a cancelled trial as unread rather than as evidence", () => {
    const out = suggestScorers(
      input({
        trials: [facts(), facts({ status: "cancelled", observed: false })],
      }),
    );
    expect(kinds(out)).not.toContain("noToolErrors");
  });
});

describe("dedupe against what the case already grades", () => {
  it("drops a check an authored step already makes", () => {
    const out = suggestScorers(
      input({
        steps: [
          prompt,
          { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
        ],
      }),
    );
    expect(kinds(out)).not.toContain("noToolErrors");
  });

  it("drops a check the case envelope already makes", () => {
    const out = suggestScorers(
      input({
        casePredicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
      }),
    );
    expect(kinds(out)).not.toContain("noToolErrors");
  });

  it("drops a check inherited from the suite", () => {
    const out = suggestScorers(
      input({ suiteDefaults: [{ type: "noToolErrors" }] }),
    );
    expect(kinds(out)).not.toContain("noToolErrors");
  });

  it("re-offers a suite check the case REPLACED — it no longer applies", () => {
    const out = suggestScorers(
      input({
        suiteDefaults: [{ type: "noToolErrors" }],
        casePredicates: { mode: "replace", list: [] },
      }),
    );
    expect(kinds(out)).toContain("noToolErrors");
  });

  it("dedupes budgets by KIND, since the number is part of the id", () => {
    const out = suggestScorers(
      input({
        casePredicates: {
          mode: "extend",
          list: [{ type: "tokenBudgetUnder", tokens: 99 }],
        },
      }),
    );
    expect(kinds(out)).not.toContain("tokenBudgetUnder");
  });
});

describe("roles follow the kind of claim", () => {
  it("never proposes a Gate from wording", () => {
    const out = suggestScorers(
      input({
        goal: "States the signed-in account email address",
        trials: [
          facts({ finalMessage: "Your email address is a@b.com" }),
          facts({ finalMessage: "The email address on file is a@b.com" }),
        ],
      }),
    );
    for (const suggestion of out.suggestions) {
      if (suggestion.predicate?.type === "responseContains") {
        expect(suggestion.role).toBe("warn");
      }
    }
  });

  it("makes budgets reports, never gates", () => {
    const out = suggestScorers(input());
    const budget = out.suggestions.find(
      (s) => s.predicate?.type === "tokenBudgetUnder",
    );
    expect(budget?.role).toBe("report");
  });

  it("gives every gate a consequence the reader can act on", () => {
    const out = suggestScorers(input());
    for (const suggestion of out.suggestions) {
      if (suggestion.role === "gate") {
        expect(suggestion.consequence).toMatch(/will fail this case/);
      }
    }
  });

  it("leads every suggestion with a purpose, not the mechanism", () => {
    const out = suggestScorers(input());
    expect(out.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of out.suggestions) {
      expect(suggestion.purpose.length).toBeGreaterThan(0);
      expect(suggestion.purpose).not.toBe(suggestion.label);
      expect(suggestion.purpose).not.toContain(
        suggestion.predicate?.type ?? "@@none@@",
      );
    }
  });
});

describe("wording suggestions come from the goal, not the answer", () => {
  it("proposes a phrase the author wrote and every answer contained", () => {
    const out = suggestScorers(
      input({
        goal: "States the signed-in account email address",
        trials: [
          facts({ finalMessage: "Your email address is a@b.com" }),
          facts({ finalMessage: "email address: a@b.com" }),
        ],
      }),
    );
    const needles = out.suggestions
      .filter((s) => s.predicate?.type === "responseContains")
      .map((s) => (s.predicate as { needle: string }).needle);
    expect(needles).toContain("email");
  });

  it("never mines an id out of the answer", () => {
    // A transient identifier that happened to appear once is not a check.
    const out = suggestScorers(
      input({
        goal: "Returns the order",
        trials: [
          facts({ finalMessage: "Order ORD-48213 is shipped" }),
          facts({ finalMessage: "Order ORD-48213 is shipped" }),
        ],
      }),
    );
    const needles = out.suggestions
      .filter((s) => s.predicate?.type === "responseContains")
      .map((s) => (s.predicate as { needle: string }).needle);
    expect(needles).not.toContain("ORD-48213");
  });

  it("needs two trials before proposing wording at all", () => {
    const out = suggestScorers(
      input({
        goal: "States the email address",
        trials: [facts({ finalMessage: "email address a@b.com" })],
      }),
    );
    expect(kinds(out)).not.toContain("responseContains");
  });
});

describe("goalNeedles", () => {
  it("drops a phrase that merely echoes the prompt", () => {
    expect(
      goalNeedles(
        "Mentions incidents",
        ["about incidents"],
        ["List incidents"],
      ),
    ).toEqual([]);
  });

  it("drops a phrase that is not in every answer", () => {
    expect(goalNeedles("Mentions widgets", ["widgets", "nothing"], [])).toEqual(
      [],
    );
  });

  it("caps at three", () => {
    expect(
      goalNeedles(
        "alpha bravo charlie delta echo foxtrot",
        ["alpha bravo charlie delta echo foxtrot"],
        [],
      ),
    ).toHaveLength(3);
  });

  it("returns nothing without a goal", () => {
    expect(goalNeedles(undefined, ["x"], [])).toEqual([]);
  });
});

describe("ceilings", () => {
  it("adds 30% headroom and rounds up to the hundred", () => {
    const out = suggestScorers(
      input({ trials: [facts({ tokensTotal: 1610 })] }),
    );
    const budget = out.suggestions.find(
      (s) => s.predicate?.type === "tokenBudgetUnder",
    );
    expect((budget?.predicate as { tokens: number }).tokens).toBe(2100);
  });

  it("says what a ceiling does NOT tell you", () => {
    const out = suggestScorers(
      input({ trials: [facts({ tokensTotal: 900 })] }),
    );
    const budget = out.suggestions.find(
      (s) => s.predicate?.type === "tokenBudgetUnder",
    );
    expect(budget?.evidence).toMatch(/does not mean this run was efficient/);
  });

  it("offers a turn ceiling only on a multi-turn case", () => {
    expect(kinds(suggestScorers(input()))).not.toContain("turnCountUnder");
    expect(
      kinds(
        suggestScorers(
          input({ trials: [facts({ turnCount: 3 }), facts({ turnCount: 2 })] }),
        ),
      ),
    ).toContain("turnCountUnder");
  });
});

describe("the route", () => {
  it("is offered when the case has none and every trial agreed", () => {
    const out = suggestScorers(input({ route: { kind: "unset" } }));
    expect(out.suggestions[0]?.kind).toBe("route");
    expect(out.suggestions[0]?.role).toBe("gate");
  });

  it("is not offered once the case already has one", () => {
    const out = suggestScorers(
      input({
        route: { kind: "tools", tools: [], matchMode: "capability" } as never,
      }),
    );
    expect(out.suggestions.some((s) => s.kind === "route")).toBe(false);
  });

  it("is not offered on a shape the route writer cannot rewrite", () => {
    // `adoptRouteFromIteration` goes through `writeSimpleCase`, which assumes
    // one prompt; on a two-turn case that rewrite would reorder turns.
    const out = suggestScorers(
      input({
        route: { kind: "unset" },
        steps: [prompt, { id: "s2", kind: "prompt", prompt: "more" }],
      }),
    );
    expect(out.suggestions.some((s) => s.kind === "route")).toBe(false);
  });

  it("says so when no tool was called at all", () => {
    const out = suggestScorers(
      input({
        route: { kind: "unset" },
        trials: [facts({ toolSequence: [] }), facts({ toolSequence: [] })],
      }),
    );
    expect(out.suggestions[0]?.evidence).toMatch(
      /No tool was called in 2 of 2/,
    );
  });
});

describe("ordering and identity", () => {
  it("puts the route first, then positioned rows, then whole-run", () => {
    const out = suggestScorers(
      input({
        route: { kind: "unset" },
        steps: [prompt, { id: "s2", kind: "prompt", prompt: "and my org?" }],
        trials: [
          facts({
            toolsByTurn: new Map([
              [0, ["get_me"]],
              [1, ["get_org"]],
            ]),
          }),
          facts({
            toolsByTurn: new Map([
              [0, ["get_me"]],
              [1, ["get_org"]],
            ]),
          }),
        ],
      }),
    );
    // The route is an adopt, so its own placement is whole-run; what the order
    // has to guarantee is that a check bound to step 2 is listed under step 2
    // and before the checks that belong to no step at all.
    const positioned = out.suggestions.findIndex(
      (s) => s.placement.kind === "afterStep",
    );
    const lastWholeRun = out.suggestions
      .map((s) => s.placement.kind)
      .lastIndexOf("wholeRun");
    expect(positioned).toBeGreaterThan(-1);
    expect(lastWholeRun).toBeGreaterThan(positioned);
  });

  it("gives every suggestion a stable, unique key", () => {
    const out = suggestScorers(input());
    const keys = out.suggestions.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(suggestScorers(input()).suggestions.map((s) => s.key)).toEqual(keys);
  });

  it("offers nothing for a kind this build does not know", () => {
    const out = suggestScorers(input({ knownKinds: new Set<string>() }));
    expect(out.suggestions.every((s) => s.kind !== "predicate")).toBe(true);
  });

  it("offers nothing at all with no trials", () => {
    const out = suggestScorers(input({ trials: [] }));
    expect(out.suggestions).toEqual([]);
    expect(out.diagnosis).toBeNull();
  });
});

describe("heldInEvery", () => {
  it("separates held, not held, and unread", () => {
    const result = heldInEvery(
      [facts(), facts(), facts({ observed: false })],
      (trial) => (trial.tokensTotal === 1000 ? true : false),
    );
    expect(result).toEqual({ held: 2, of: 3, unread: 1 });
  });
});

describe("a placeholder route is not a success signal", () => {
  it("does not treat an unrestricted route as a gate that proved success", () => {
    // The Route row is always `role: "gate"`, including when it restricts
    // nothing. Counting it made a prompt-and-goal case look gated, so a
    // passing unjudged run supplied a signal it had not earned — and the
    // engine went on to suggest requiring whatever tool it happened to call.
    const out = suggestScorers(
      input({
        route: { kind: "checks" },
        trials: [
          facts({ successSignal: "none", toolSequence: ["wrong_tool"] }),
          facts({ successSignal: "none", toolSequence: ["wrong_tool"] }),
        ],
      }),
    );
    expect(out.diagnosis?.noSignal).toBe(true);
    expect(out.suggestions.every((s) => s.role !== "gate")).toBe(true);
    expect(
      out.suggestions.some((s) =>
        JSON.stringify(s.predicate ?? {}).includes("wrong_tool"),
      ),
    ).toBe(false);
  });
});
