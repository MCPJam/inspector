/**
 * Client adapter for route facts: catalog read, iteration mapping, copy.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_MISMATCH_TOOLS,
  evalCaseAggregationKey,
  type EvalRunRouteFactsCase,
} from "@mcpjam/sdk/contract";

import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";
import {
  ROUTE_LINE_MAX_ROUTES,
  buildRunRouteFacts,
  frictionHeadingFor,
  frictionLineForTrial,
  iterationToRouteTrial,
  readTrialFrictionSignals,
  readTrialSuspectedCondition,
  suspectedConditionLineForTrial,
  suspectedConditionUnavailable,
  mismatchLines,
  readRunToolCatalog,
  routeFactsForRow,
  routeLine,
  routeLineForRow,
  variantLabel,
} from "../route-facts-model";

const run = (over: Partial<EvalSuiteRun> = {}): EvalSuiteRun =>
  ({
    _id: "run_1",
    suiteId: "suite_1",
    createdBy: "u",
    runNumber: 1,
    configRevision: "cfg",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    ...over,
  } as EvalSuiteRun);

const iteration = (over: Partial<EvalIteration> = {}): EvalIteration =>
  ({
    _id: "it_1",
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result: "failed",
    actualToolCalls: [],
    tokensUsed: 0,
    testCaseId: "case_a",
    testCaseSnapshot: {
      title: "Look up a user",
      query: "q",
      provider: "anthropic",
      model: "claude",
      expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
    },
    ...over,
  } as EvalIteration);

const row = (over: Partial<EvaluateCaseRow> = {}): EvaluateCaseRow =>
  ({
    key: "case_a",
    title: "Look up a user",
    testCaseId: "case_a",
    caseKey: "case_a",
    iterations: { passed: 0, total: 1 },
    verdict: { kind: "legacyRun" },
    mark: "failed",
    break: { kind: "none" },
    cells: [],
    coverage: {
      total: 1,
      loaded: 1,
      breaksByStage: {
        connection: 0,
        discovery: 0,
        selection: 0,
        call: 0,
        response: 0,
        userValue: 0,
      },
      withheld: 0,
      note: null,
    },
    p50Ms: null,
    opensIterationId: "it_1",
    diagnostic: null,
    failureGroups: [],
    ...over,
  } as EvaluateCaseRow);

describe("readRunToolCatalog", () => {
  it("reads inline server tool names and the hash", () => {
    expect(
      readRunToolCatalog(
        run({
          toolSnapshotHash: "hash_1",
          toolSnapshot: {
            servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
          },
        }),
      ),
    ).toEqual({
      state: "loaded",
      toolNames: ["tool_a", "tool_b"],
      hash: "hash_1",
    });
  });

  it("is notLoaded when the snapshot is absent", () => {
    expect(readRunToolCatalog(run())).toEqual({ state: "notLoaded" });
  });

  it("is loaded, and empty, when the snapshot is present but lists no tools", () => {
    expect(
      readRunToolCatalog(run({ toolSnapshot: { servers: [{ tools: [] }] } })),
    ).toEqual({ state: "loaded", toolNames: [] });
  });

  it("is notLoaded when a server entry carries no tool list", () => {
    // Not a server with no tools: a catalog the page cannot read, and one
    // it must not vouch for by filing every called tool as outsideCatalog.
    expect(
      readRunToolCatalog(run({ toolSnapshot: { servers: [{}] } })),
    ).toEqual({ state: "notLoaded" });
  });

  it("is notLoaded when a tool entry carries no name", () => {
    expect(
      readRunToolCatalog(
        run({
          toolSnapshot: { servers: [{ tools: [{ name: "tool_a" }, {}] }] },
        }),
      ),
    ).toEqual({ state: "notLoaded" });
  });
});

describe("iterationToRouteTrial", () => {
  it("keys by caseKey and the snapshot variant — not the verdict key", () => {
    const trial = iterationToRouteTrial(iteration());
    expect(trial.caseVariantKey).toBe(
      evalCaseAggregationKey({
        caseId: "case_a",
        executionVariant: { model: "claude", provider: "anthropic" },
      }),
    );
    expect(trial.caseKey).toBe("case_a");
  });

  it("treats metadata.failureCategory evaluator as evaluatorErrored", () => {
    expect(
      iterationToRouteTrial(
        iteration({ metadata: { failureCategory: "evaluator" } }),
      ).evaluatorErrored,
    ).toBe(true);
  });
});

describe("copy helpers", () => {
  it("summarises an all-pass single route", () => {
    const doc = buildRunRouteFacts(
      run({
        toolSnapshot: {
          servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
        },
      }),
      [
        iteration({
          result: "passed",
          actualToolCalls: [
            { toolName: "tool_a", arguments: {} },
            { toolName: "tool_b", arguments: {} },
          ],
          testCaseSnapshot: {
            title: "Look up a user",
            query: "q",
            provider: "anthropic",
            model: "claude",
            expectedToolCalls: [
              { toolName: "tool_a", arguments: {} },
              { toolName: "tool_b", arguments: {} },
            ],
          },
        }),
      ],
    );
    const facts = routeFactsForRow(doc!, row(), [
      iteration({ result: "passed" }),
    ]);
    expect(facts).toHaveLength(1);
    expect(routeLine(facts[0]!)).toBe("1 took `tool_a→tool_b`");
  });

  it("returns every variant of a row that ran on two models, labelled", () => {
    const onClaude = iteration({
      _id: "it_claude",
      result: "passed",
      actualToolCalls: [{ toolName: "tool_a", arguments: {} }],
    });
    const onGpt = iteration({
      _id: "it_gpt",
      result: "failed",
      actualToolCalls: [],
      testCaseSnapshot: {
        title: "Look up a user",
        query: "q",
        provider: "openai",
        model: "gpt",
        expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
      },
    });
    const doc = buildRunRouteFacts(run(), [onClaude, onGpt]);
    const facts = routeFactsForRow(doc!, row(), [onClaude, onGpt]);
    expect(facts).toHaveLength(2);
    expect(facts.map(variantLabel).sort()).toEqual([
      "claude (anthropic)",
      "gpt (openai)",
    ]);
    const line = routeLineForRow(facts);
    expect(line).toContain("claude (anthropic): 1 took `tool_a`");
    expect(line).toContain("gpt (openai): 1 called nothing");
    expect(line).not.toContain("\n");
  });

  it("keeps a ten-route case to one line: three routes and a count", () => {
    const iterations = Array.from({ length: 10 }, (_, index) =>
      iteration({
        _id: `it_${index}`,
        actualToolCalls: [
          { toolName: "tool_a", arguments: {} },
          { toolName: `tool_${index}`, arguments: {} },
        ],
      }),
    );
    const doc = buildRunRouteFacts(run(), iterations);
    const line = routeLine(doc!.cases[0]!);
    expect(line).not.toContain("\n");
    expect(line.match(/ took `/g)).toHaveLength(ROUTE_LINE_MAX_ROUTES);
    expect(line).toMatch(/ · 7 other routes$/);
  });

  it("adds the document's folded routes to the count when it says how many", () => {
    const iterations = Array.from({ length: 5 }, (_, index) =>
      iteration({
        _id: `it_${index}`,
        actualToolCalls: [{ toolName: `tool_${index}`, arguments: {} }],
      }),
    );
    const facts = buildRunRouteFacts(run(), iterations)!.cases[0]!;
    const other = { trials: 4, passed: 1, failed: 3 };
    const withCount = {
      ...facts,
      routes: {
        ...facts.routes,
        otherRoutes: { ...other, distinctPaths: 6 },
      },
    } as EvalRunRouteFactsCase;
    expect(routeLine(withCount)).toMatch(/ · 8 other routes$/);
    const withoutCount = {
      ...facts,
      routes: { ...facts.routes, otherRoutes: other },
    } as EvalRunRouteFactsCase;
    expect(routeLine(withoutCount)).toMatch(/ · 2\+ other routes$/);
  });

  it("names only the first tool a case looped on", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        _id: "it_loop",
        actualToolCalls: [
          { toolName: "tool_a", arguments: {} },
          { toolName: "tool_a", arguments: {} },
          { toolName: "tool_a", arguments: {} },
          { toolName: "tool_b", arguments: {} },
          { toolName: "tool_b", arguments: {} },
          { toolName: "tool_b", arguments: {} },
        ],
      }),
    ]);
    const facts = doc!.cases[0]!;
    if (facts.routes.loopedOn.length < 2) {
      // The document folds repeats before this rule can bite; nothing to cap.
      expect(routeLine(facts).match(/looped on/g)?.length ?? 0).toBeLessThan(2);
      return;
    }
    expect(routeLine(facts).match(/looped on/g)).toHaveLength(1);
  });

  it("returns null instead of throwing when the contract rejects the run", () => {
    // An empty run id fails the document's `runId: min(1)` rule.
    expect(
      buildRunRouteFacts(run({ _id: "" as never }), [iteration()]),
    ).toBeNull();
  });

  it("states not-called, unexpected, substitution, and not-measured question", () => {
    const doc = buildRunRouteFacts(
      run({
        toolSnapshot: {
          servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
        },
      }),
      [
        iteration({
          actualToolCalls: [{ toolName: "tool_b", arguments: {} }],
          testCaseSnapshot: {
            title: "Look up a user",
            query: "q",
            provider: "anthropic",
            model: "claude",
            expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
          },
        }),
      ],
    );
    const facts = doc!.cases[0]!;
    expect(facts.mismatch).toMatchObject({ gradeableTrials: 1 });
    expect(routeLine(facts)).toBe("1 took `tool_b`");
    expect(mismatchLines(facts, doc!.catalogState)).toEqual([
      "expected `tool_a` not called in 1 of 1",
      "`tool_b` called in 1 of 1 (1 failed)",
      "`tool_b` called instead of `tool_a` in 1 iteration",
      "ended with a question: not measured",
    ]);
  });

  it("pluralizes a substitution seen more than once, and notes a capped list", () => {
    const doc = buildRunRouteFacts(
      run({
        toolSnapshot: {
          servers: [{ tools: [{ name: "tool_a" }, { name: "tool_b" }] }],
        },
      }),
      [
        iteration({
          actualToolCalls: [{ toolName: "tool_b", arguments: {} }],
          testCaseSnapshot: {
            title: "Look up a user",
            query: "q",
            provider: "anthropic",
            model: "claude",
            expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
          },
        }),
      ],
    );
    const facts = doc!.cases[0]!;
    if (facts.mismatch.state !== "measured")
      throw new Error("expected measured");
    const capped = {
      ...facts,
      mismatch: {
        ...facts.mismatch,
        substitutions: [{ expected: "tool_a", observed: "tool_b", trials: 2 }],
        truncated: true as const,
      },
    } as EvalRunRouteFactsCase;
    const lines = mismatchLines(capped, doc!.catalogState);
    expect(lines).toContain("`tool_b` called instead of `tool_a` in 2 iterations");
    expect(lines).toContain(
      `mismatch lists capped at ${MAX_MISMATCH_TOOLS} entries each`,
    );
  });

  it("labels a negative no-tool route as expected and omits mismatch copy", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        result: "passed",
        actualToolCalls: [],
        testCaseSnapshot: {
          title: "Do not call anything",
          query: "q",
          provider: "anthropic",
          model: "claude",
          expectedToolCalls: [{ toolName: "tool_a", arguments: {} }],
          isNegativeTest: true,
        },
      }),
    ]);
    const facts = doc!.cases[0]!;
    expect(routeLine(facts)).toBe("1 called nothing (expected)");
    expect(mismatchLines(facts, doc!.catalogState)).toEqual([
      "ended with a question: not measured",
    ]);
  });

  it("notes catalog-not-loaded and never classifies a substitution", () => {
    const doc = buildRunRouteFacts(run(), [
      iteration({
        actualToolCalls: [{ toolName: "tool_b", arguments: {} }],
      }),
    ]);
    expect(doc!.catalogState).toBe("notLoaded");
    expect(doc!.cases[0]!.mismatch).toMatchObject({
      state: "measured",
      substitutions: [],
    });
    expect(mismatchLines(doc!.cases[0]!, doc!.catalogState)).toContain(
      "catalog not loaded. Substitutions were not classified",
    );
  });
});

// ── friction signals ─────────────────────────────────────────────────────────

const measuredFriction = (over: Record<string, unknown> = {}) => ({
  version: 1,
  state: "measured",
  callCount: 4,
  resultAvailableCount: 4,
  timedCallCount: 0,
  identifierSignals: { state: "measured" },
  signals: [],
  ...over,
});

describe("readTrialFrictionSignals", () => {
  it("takes a document that validates", () => {
    const parsed = readTrialFrictionSignals(
      iteration({ metadata: { frictionSignals: measuredFriction() } } as never),
    );
    expect(parsed).toMatchObject({ state: "measured", callCount: 4 });
  });

  it("refuses one that does not, rather than half-trusting it", () => {
    expect(
      readTrialFrictionSignals(
        iteration({
          metadata: {
            frictionSignals: measuredFriction({
              identifierSignals: {
                state: "notMeasured",
                reason: "resultsUnavailable",
              },
              signals: [
                {
                  kind: "identifierSurfacedUnused",
                  informationCallIndex: 0,
                  observedAtCallIndex: 2,
                  toolName: "search_issues",
                  identifierKeyPaths: ["results[].id"],
                  identifierCount: 1,
                  laterCallCount: 2,
                },
              ],
            }),
          },
        } as never),
      ),
    ).toBeUndefined();
    expect(readTrialFrictionSignals(iteration())).toBeUndefined();
  });

  it("reaches the trial input, so the rates have something to count", () => {
    const trial = iterationToRouteTrial(
      iteration({ metadata: { frictionSignals: measuredFriction() } } as never),
    );
    expect(trial.frictionSignals).toMatchObject({ state: "measured" });
    expect(iterationToRouteTrial(iteration()).frictionSignals).toBeUndefined();
  });
});

describe("frictionLineForTrial", () => {
  it("names the tool, the key path and the calls, in observation words", () => {
    const line = frictionLineForTrial(
      measuredFriction({
        signals: [
          {
            kind: "identifierSurfacedUnused",
            informationCallIndex: 1,
            observedAtCallIndex: 3,
            toolName: "search_issues",
            identifierKeyPaths: ["results[].id"],
            identifierCount: 2,
            laterCallCount: 2,
          },
          {
            kind: "searchRepeatedAfterIdentifier",
            informationCallIndex: 1,
            observedAtCallIndex: 3,
            toolName: "search_issues",
            repeatCallIndexes: [2, 3],
            identifierKeyPaths: ["results[].id"],
            identifierCount: 2,
          },
        ],
      }) as never,
    );
    expect(line).toBe(
      "Possible detour: `search_issues` returned identifiers (results[].id) at " +
        "call 1 that no later call used; `search_issues` was called again at " +
        "calls 2 and 3",
    );
  });

  it("heads the line with the DETOUR, not with whatever happened first", () => {
    // Cursor Bugbot found this: signals are ordered by the call that made each
    // observable, so heading the row with `signals[0]` labels a trial by
    // whatever happened soonest. A pagination at call 1 then hides an unused
    // identifier at call 8 behind the word "Pagination" — and a reader
    // scanning collapsed rows skips the one row that had something to say,
    // taking the suspected condition underneath it along too.
    const line = frictionLineForTrial(
      measuredFriction({
        callCount: 9,
        resultAvailableCount: 9,
        signals: [
          {
            kind: "paginationContinuation",
            callIndex: 1,
            priorCallIndex: 0,
            toolName: "list_pages",
            paginationKeys: ["cursor"],
          },
          {
            kind: "identifierSurfacedUnused",
            informationCallIndex: 6,
            observedAtCallIndex: 8,
            toolName: "search_issues",
            identifierKeyPaths: ["results[].id"],
            identifierCount: 1,
            laterCallCount: 2,
          },
        ],
      }) as never,
    );
    expect(line!.startsWith("Possible detour:")).toBe(true);
    // And the pagination is still reported, just not as the headline.
    expect(line).toContain("continued pagination at call 1");
  });

  it("picks the heading by consequence: detour over retry over pagination", () => {
    const heading = (kinds: string[]) =>
      frictionHeadingFor(kinds.map((kind) => ({ kind })) as never);
    expect(heading(["paginationContinuation", "identicalRetry"])).toBe("Retry");
    expect(
      heading([
        "paginationContinuation",
        "changedRetry",
        "identifierSurfacedUnused",
      ]),
    ).toBe("Possible detour");
    expect(heading(["paginationContinuation"])).toBe("Pagination");
    expect(heading(["identicalRetry", "searchRepeatedAfterIdentifier"])).toBe(
      "Possible detour",
    );
  });

  it("never says wasted, unnecessary, or blames the server", () => {
    const line =
      frictionLineForTrial(
        measuredFriction({
          signals: [
            {
              kind: "identicalRetry",
              callIndex: 2,
              priorCallIndex: 1,
              toolName: "get_issue",
              afterError: true,
            },
          ],
        }) as never,
      ) ?? "";
    expect(line).toBe(
      "Retry: `get_issue` repeated with identical arguments at call 2 after an error",
    );
    for (const word of ["wasted", "unnecessary", "the server", "caused"]) {
      expect(line.toLowerCase()).not.toContain(word);
    }
  });

  it("heads a pagination-only trial as Pagination, not a detour", () => {
    expect(
      frictionLineForTrial(
        measuredFriction({
          signals: [
            {
              kind: "paginationContinuation",
              callIndex: 1,
              priorCallIndex: 0,
              toolName: "list_pages",
              paginationKeys: ["cursor"],
            },
          ],
        }) as never,
      ),
    ).toBe("Pagination: `list_pages` continued pagination at call 1 (cursor)");
  });

  it("says not measured with the reason, and stays silent when nothing fired", () => {
    expect(
      frictionLineForTrial({
        version: 1,
        state: "notMeasured",
        notMeasuredReason: "resultsUnavailable",
        callCount: 2,
        resultAvailableCount: 0,
        timedCallCount: 0,
        identifierSignals: {
          state: "notMeasured",
          reason: "resultsUnavailable",
        },
        signals: [],
      } as never),
    ).toBe("friction signals: not measured — tool results were not retained");
    expect(frictionLineForTrial(measuredFriction() as never)).toBeNull();
    expect(frictionLineForTrial(undefined)).toBeNull();
  });
});

describe("mismatchLines — friction rates", () => {
  const facts = (frictionSignals: unknown): EvalRunRouteFactsCase =>
    ({
      caseVariantKey: "k",
      routes: {
        population: "trial",
        totalTrials: 4,
        includedTrials: 4,
        exclusions: {},
        routes: [],
        tags: {
          noToolCalled: {
            state: "notMeasured",
            value: null,
            numerator: 0,
            denominator: 0,
            exclusions: {},
          },
          retried: {
            state: "notMeasured",
            value: null,
            numerator: 0,
            denominator: 0,
            exclusions: {},
          },
          looping: {
            state: "notMeasured",
            value: null,
            numerator: 0,
            denominator: 0,
            exclusions: {},
          },
        },
        loopedOn: [],
        endedWithQuestion: {
          state: "notMeasured",
          value: null,
          numerator: 0,
          denominator: 0,
          exclusions: {},
        },
        frictionSignals,
      },
      mismatch: { state: "notMeasured" },
    } as unknown as EvalRunRouteFactsCase);

  const rate = (numerator: number, denominator: number) => ({
    state: "measured" as const,
    value: numerator / denominator,
    numerator,
    denominator,
    exclusions: {},
  });

  it("states each rate's OWN denominator, so the two are never conflated", () => {
    const lines = mismatchLines(
      facts({
        identifierSurfacedUnused: rate(1, 2),
        searchRepeatedAfterIdentifier: rate(0, 2),
        identicalRetry: rate(3, 4),
        changedRetry: rate(0, 4),
        paginationContinuation: rate(0, 4),
      }),
      "loaded",
    );
    expect(lines).toContain("identifiers surfaced, none used later: 1 of 2");
    expect(lines).toContain("repeated with identical arguments: 3 of 4");
    // A rate that fired on nothing gets no line — "0 of 4" invites a reader to
    // go looking for something that is not there.
    expect(lines.join(" ")).not.toContain("0 of 4");
  });

  it("says not measured rather than zero", () => {
    const lines = mismatchLines(
      facts({
        identifierSurfacedUnused: {
          state: "notMeasured",
          value: null,
          numerator: 0,
          denominator: 0,
          exclusions: {},
        },
        searchRepeatedAfterIdentifier: {
          state: "notMeasured",
          value: null,
          numerator: 0,
          denominator: 0,
          exclusions: {},
        },
        identicalRetry: rate(1, 4),
        changedRetry: rate(0, 4),
        paginationContinuation: rate(0, 4),
      }),
      "loaded",
    );
    expect(lines).toContain(
      "identifiers surfaced, none used later: not measured",
    );
  });

  it("adds no friction line at all when the block is absent", () => {
    // The `endedWithQuestion` line is this fixture's own and is not a friction
    // rate; a run whose producer predates the measurement gains nothing here.
    expect(mismatchLines(facts(undefined), "loaded")).toEqual([
      "ended with a question: not measured",
    ]);
  });
});

describe("the suspected condition (step 2)", () => {
  const verdict = (over: Record<string, unknown> = {}) => ({
    status: "scored",
    condition: "idBuriedInPayload",
    confidence: "high",
    remediation: "Surface `results[].id` at the top level of `search_issues`.",
    gradingKey: "case_a#1",
    signalKind: "identifierSurfacedUnused",
    informationCallIndex: 0,
    observedAtCallIndex: 2,
    judgeTemplateVersion: 1,
    judgeTemplateHash: "h",
    model: "openai/gpt-5.4-mini",
    generatedAt: 1,
    ...over,
  });

  const read = (raw: unknown) =>
    readTrialSuspectedCondition(
      iteration({ metadata: { suspectedConditionVerdict: raw } } as never),
    );

  it("names the condition, the confidence and one server lever", () => {
    expect(suspectedConditionLineForTrial(read(verdict()))).toEqual({
      line: "Suspected condition: identifier buried in payload (high confidence)",
      next: "Surface `results[].id` at the top level of `search_issues`.",
    });
  });

  it("unclear reads as could not attribute, with NO next step", () => {
    const line = suspectedConditionLineForTrial(
      read(verdict({ condition: "unclear", remediation: undefined })),
    );
    expect(line).toEqual({ line: "Suspected condition: could not attribute" });
    expect(line!.next).toBeUndefined();
  });

  it("responseWasClear keeps its label and takes no next step", () => {
    const line = suspectedConditionLineForTrial(
      read(verdict({ condition: "responseWasClear", remediation: undefined })),
    );
    expect(line).toEqual({
      line: "Suspected condition: the response was clear (high confidence)",
    });
  });

  it("renders nothing for skipped, error, or a trial never judged", () => {
    for (const raw of [
      verdict({
        status: "skipped",
        reason: "cap",
        condition: undefined,
        confidence: undefined,
        remediation: undefined,
      }),
      verdict({
        status: "error",
        condition: undefined,
        confidence: undefined,
        remediation: undefined,
      }),
    ]) {
      expect(suspectedConditionLineForTrial(read(raw))).toBeNull();
    }
    expect(suspectedConditionLineForTrial(undefined)).toBeNull();
  });

  it("refuses a verdict that does not validate, and says it is unavailable", () => {
    const forged = iteration({
      metadata: {
        suspectedConditionVerdict: {
          status: "scored",
          condition: "theServerIsBad",
          confidence: "high",
        },
      },
    } as never);
    expect(readTrialSuspectedCondition(forged)).toBeUndefined();
    expect(suspectedConditionUnavailable(forged)).toBe(true);
    expect(suspectedConditionUnavailable(iteration())).toBe(false);
  });

  it("never says caused", () => {
    const line = suspectedConditionLineForTrial(read(verdict()))!;
    expect(`${line.line} ${line.next}`.toLowerCase()).not.toContain("caused");
  });
});
