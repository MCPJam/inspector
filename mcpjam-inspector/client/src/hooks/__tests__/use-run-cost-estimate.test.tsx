import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONTRACT for the pre-run credit estimate's client half:
 *
 *  1. Flag off ⇒ the hint does not render AND no Convex query is dispatched.
 *     The backend queries are read-only, so this gate exists to control rollout
 *     and read volume — but a hidden hint that still fetches would defeat that.
 *  2. The fetch happens on tooltip OPEN, not on mount, and re-fetches when the
 *     arguments change while open. A stale/out-of-order response must never
 *     paint over a newer one.
 *  3. The tooltip copy is a function of BOTH coverage and confidence, and a
 *     query rejection (e.g. TOO_MANY_MODELS) reads "Estimate unavailable".
 */

const queryCalls: Array<{ name: string; args: unknown }> = [];
let queryImpl: (name: string, args: unknown) => Promise<unknown> = async () =>
  undefined;

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: (name: string, args: unknown) => {
      queryCalls.push({ name, args });
      return queryImpl(name, args);
    },
  }),
}));

let flagEnabled: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagEnabled,
}));

import {
  RUN_COST_ESTIMATE_QUERIES,
  formatCredits,
  formatRunCostEstimate,
  useJourneyRunCostEstimate,
  useQuickCaseRunCostEstimate,
  useSuiteRunCostEstimate,
  type RunCostEstimate,
} from "../use-run-cost-estimate";
import {
  JourneyRunCostEstimateHint,
  QuickCaseRunCostEstimateHint,
  SuiteRunCostEstimateHint,
} from "@/components/evals/run-cost-estimate-hint";

function estimate(overrides: Partial<RunCostEstimate> = {}): RunCostEstimate {
  return {
    credits: 42,
    lowerBoundCredits: 42,
    usd: 0.42,
    coverage: "full",
    confidence: "partial",
    sampleCount: 3,
    truncated: false,
    lines: [],
    ...overrides,
  };
}

beforeEach(() => {
  queryCalls.length = 0;
  flagEnabled = true;
  queryImpl = async () => estimate();
});

afterEach(() => {
  cleanup();
});

const MODELS = [{ model: "gpt-5-mini", provider: "openai" }];

describe("QuickCaseRunCostEstimateHint — flag gate", () => {
  it("renders nothing and dispatches no query when the flag is off", async () => {
    flagEnabled = false;
    render(
      <QuickCaseRunCostEstimateHint
        suiteId="suite-1"
        caseId="case-1"
        models={MODELS}
      />,
    );
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
    // Give any stray effect a chance to fire before asserting the absence.
    await Promise.resolve();
    expect(queryCalls).toHaveLength(0);
  });

  it("treats an unresolved flag as off (fail-closed)", async () => {
    flagEnabled = undefined;
    render(
      <QuickCaseRunCostEstimateHint
        suiteId="suite-1"
        caseId="case-1"
        models={MODELS}
      />,
    );
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
    await Promise.resolve();
    expect(queryCalls).toHaveLength(0);
  });

  it("renders nothing and dispatches no query when suppressed", async () => {
    // `suppressed` is how a caller says "this control won't actually run"
    // (env suite / no models / render check).
    render(
      <QuickCaseRunCostEstimateHint
        suiteId="suite-1"
        caseId="case-1"
        models={[]}
        suppressed
      />,
    );
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
    await Promise.resolve();
    expect(queryCalls).toHaveLength(0);
  });

  it("renders the trigger but fetches nothing until the tooltip opens", async () => {
    render(
      <QuickCaseRunCostEstimateHint
        suiteId="suite-1"
        caseId="case-1"
        models={MODELS}
      />,
    );
    expect(screen.getByTestId("run-cost-estimate-hint")).toBeInTheDocument();
    await Promise.resolve();
    expect(queryCalls).toHaveLength(0);
  });
});

describe("suite + journey wrappers — flag gate", () => {
  // Same gate-then-mount structure as the quick-case wrapper: the flag is
  // checked BEFORE the fetch hook is mounted, so a flagged-off surface
  // constructs no state machine at all. That matters most for journeys, where
  // the list renders one of these per card.
  const cases = [
    {
      name: "SuiteRunCostEstimateHint",
      render: () => <SuiteRunCostEstimateHint suiteId="suite-1" planCount={2} />,
    },
    {
      name: "JourneyRunCostEstimateHint",
      render: () => <JourneyRunCostEstimateHint journeyId="journey-1" />,
    },
  ];

  for (const surface of cases) {
    it(`${surface.name} renders nothing and dispatches no query when the flag is off`, async () => {
      flagEnabled = false;
      render(surface.render());
      expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
      await Promise.resolve();
      expect(queryCalls).toHaveLength(0);
    });

    it(`${surface.name} treats an unresolved flag as off`, async () => {
      flagEnabled = undefined;
      render(surface.render());
      expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
      await Promise.resolve();
      expect(queryCalls).toHaveLength(0);
    });

    it(`${surface.name} renders the trigger but fetches nothing until opened`, async () => {
      render(surface.render());
      expect(screen.getByTestId("run-cost-estimate-hint")).toBeInTheDocument();
      await Promise.resolve();
      expect(queryCalls).toHaveLength(0);
    });
  }

  it("suppresses the suite hint when Run all cannot launch", async () => {
    render(
      <SuiteRunCostEstimateHint suiteId="suite-1" planCount={2} suppressed />,
    );
    expect(screen.queryByTestId("run-cost-estimate-hint")).toBeNull();
    await Promise.resolve();
    expect(queryCalls).toHaveLength(0);
  });
});

/** Harness that drives `setOpen` / arg changes directly — the tooltip's own
 * pointer interactions are Radix's business, the state machine is ours. */
function EstimateProbe({
  models,
  open,
}: {
  models: Array<{ model: string; provider: string }>;
  open: boolean;
}) {
  const state = useQuickCaseRunCostEstimate({
    enabled: true,
    suiteId: "suite-1",
    caseId: "case-1",
    models,
  });
  // Mirror the tooltip's open/close into the hook.
  useEffect(() => {
    state.setOpen(open);
  }, [open, state.setOpen]);
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="copy">{formatRunCostEstimate(state)}</span>
      <span data-testid="credits">{state.estimate?.credits ?? ""}</span>
    </div>
  );
}

describe("useQuickCaseRunCostEstimate — fetch on open", () => {
  it("dispatches the quick-case query with the models the run will use", async () => {
    const { rerender } = render(<EstimateProbe models={MODELS} open={false} />);
    expect(queryCalls).toHaveLength(0);

    rerender(<EstimateProbe models={MODELS} open />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    expect(queryCalls[0].name).toBe(RUN_COST_ESTIMATE_QUERIES.quickCase);
    expect(queryCalls[0].args).toEqual({
      suiteId: "suite-1",
      caseId: "case-1",
      models: MODELS,
    });
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready"),
    );
  });

  it("re-fetches when the args change while open", async () => {
    const { rerender } = render(<EstimateProbe models={MODELS} open />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));

    rerender(
      <EstimateProbe
        models={[...MODELS, { model: "gpt-5", provider: "openai" }]}
        open
      />,
    );
    await waitFor(() => expect(queryCalls).toHaveLength(2));
    expect((queryCalls[1].args as { models: unknown[] }).models).toHaveLength(
      2,
    );
  });

  it("re-fetches for two model lists that a delimiter key would collide", async () => {
    // `model` can itself contain "/" (canonical ids live there), so a
    // `provider/model` join would render both of these as "a/b,c/d" — leaving
    // the tooltip on the previous estimate after a real model change.
    const { rerender } = render(
      <EstimateProbe models={[{ provider: "a", model: "b,c/d" }]} open />,
    );
    await waitFor(() => expect(queryCalls).toHaveLength(1));

    rerender(
      <EstimateProbe
        models={[
          { provider: "a", model: "b" },
          { provider: "c", model: "d" },
        ]}
        open
      />,
    );
    await waitFor(() => expect(queryCalls).toHaveLength(2));
    expect((queryCalls[1].args as { models: unknown[] }).models).toHaveLength(2);
  });

  it("discards a stale response when the args changed mid-flight", async () => {
    // First request resolves LAST and with a different number — if request-id
    // tagging were missing, it would paint over the newer answer.
    const resolvers: Array<(value: RunCostEstimate) => void> = [];
    queryImpl = () =>
      new Promise<RunCostEstimate>((resolve) => {
        resolvers.push(resolve);
      });

    const { rerender } = render(<EstimateProbe models={MODELS} open />);
    await waitFor(() => expect(resolvers).toHaveLength(1));

    rerender(
      <EstimateProbe models={[{ model: "gpt-5", provider: "openai" }]} open />,
    );
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // Newer request answers first, then the stale one.
    resolvers[1](estimate({ credits: 7, lowerBoundCredits: 7 }));
    await waitFor(() =>
      expect(screen.getByTestId("credits").textContent).toBe("7"),
    );
    resolvers[0](estimate({ credits: 999, lowerBoundCredits: 999 }));
    // Flush to the end of the macrotask queue, not just one microtask: if the
    // request-id guard regressed, the stale write needs a real chance to commit
    // before we can claim it didn't happen. (A `waitFor` on "7" would be no
    // stronger — it passes on its first poll and never sees a later overwrite.)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("credits").textContent).toBe("7");
  });

  it("clears the painted estimate when the tooltip closes", async () => {
    const { rerender } = render(<EstimateProbe models={MODELS} open />);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready"),
    );
    rerender(<EstimateProbe models={MODELS} open={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("idle"),
    );
    expect(screen.getByTestId("credits").textContent).toBe("");
  });

  it("surfaces a rejected query as an error state", async () => {
    queryImpl = async () => {
      throw new Error(
        'ConvexError: {"code":"TOO_MANY_MODELS","message":"Cost estimation supports at most 10 distinct models (received 11)."}',
      );
    };
    render(<EstimateProbe models={MODELS} open />);
    await waitFor(() =>
      expect(screen.getByTestId("copy").textContent).toBe(
        "Estimate unavailable",
      ),
    );
  });
});

describe("formatRunCostEstimate — copy matrix", () => {
  it("full + historical", () => {
    expect(
      formatRunCostEstimate({
        status: "ready",
        error: null,
        estimate: estimate({ confidence: "historical" }),
      }),
    ).toBe("Estimated: ~42 credits — based on your recent runs");
  });

  it("full + partial (the normal eval case)", () => {
    expect(
      formatRunCostEstimate({
        status: "ready",
        error: null,
        estimate: estimate({ confidence: "partial" }),
      }),
    ).toBe("Estimated: ~42 credits — partly based on recent runs");
  });

  it("full + heuristic (cold start)", () => {
    expect(
      formatRunCostEstimate({
        status: "ready",
        error: null,
        estimate: estimate({ confidence: "heuristic" }),
      }),
    ).toBe("Rough estimate: ~42 credits — improves after first run");
  });

  it("partial coverage is phrased as a floor regardless of confidence", () => {
    for (const confidence of ["historical", "partial", "heuristic"] as const) {
      expect(
        formatRunCostEstimate({
          status: "ready",
          error: null,
          estimate: estimate({
            coverage: "partial",
            confidence,
            credits: null,
            usd: null,
            lowerBoundCredits: 30,
          }),
        }),
      ).toBe("At least ~30 credits — part of this run is unpriced");
    }
  });

  it("no coverage says so explicitly", () => {
    expect(
      formatRunCostEstimate({
        status: "ready",
        error: null,
        estimate: estimate({
          coverage: "none",
          confidence: "unavailable",
          credits: null,
          usd: null,
          lowerBoundCredits: 0,
        }),
      }),
    ).toBe("Estimate unavailable for these models");
  });

  it("idle reads as pending, not unavailable", () => {
    // `idle` is the frame between the tooltip opening and the fetch effect
    // committing `loading`. It must not flash "Estimate unavailable" and then
    // retract it.
    expect(
      formatRunCostEstimate({ status: "idle", error: null, estimate: null }),
    ).toBe("Estimating…");
  });

  it("loading and error states", () => {
    expect(
      formatRunCostEstimate({
        status: "loading",
        error: null,
        estimate: null,
      }),
    ).toBe("Estimating…");
    expect(
      formatRunCostEstimate({
        status: "error",
        error: "boom",
        estimate: null,
      }),
    ).toBe("Estimate unavailable");
  });

  it("never renders a nonzero cost as ~0 credits", () => {
    // Backend credits are integers by construction, so this is a guard rather
    // than a live case: the one direction this display must not fail in is low.
    expect(formatCredits(0.4)).toBe("1");
    expect(formatCredits(0)).toBe("0");
    expect(formatCredits(-5)).toBe("0");
    // Identity on the integers that actually arrive.
    expect(formatCredits(42)).toBe("42");
    expect(formatCredits(12_345)).toBe("12,345");
  });

  it("formats large totals with thousands separators", () => {
    expect(
      formatRunCostEstimate({
        status: "ready",
        error: null,
        estimate: estimate({
          confidence: "historical",
          credits: 12_345,
          lowerBoundCredits: 12_345,
        }),
      }),
    ).toBe("Estimated: ~12,345 credits — based on your recent runs");
  });
});

/** Suite + journey surfaces share the same state machine; assert each dispatches
 * its own query name with the args the backend expects. */
function SuiteProbe({
  planCount,
  iterationOverride,
}: {
  planCount: number;
  iterationOverride?: number;
}) {
  const state = useSuiteRunCostEstimate({
    enabled: true,
    suiteId: "suite-1",
    planCount,
    ...(iterationOverride !== undefined ? { iterationOverride } : {}),
  });
  useEffect(() => {
    state.setOpen(true);
  }, [state.setOpen]);
  return <span data-testid="status">{state.status}</span>;
}

function JourneyProbe({ configKey }: { configKey?: string } = {}) {
  const state = useJourneyRunCostEstimate({
    enabled: true,
    journeyId: "journey-1",
    configKey,
  });
  useEffect(() => {
    state.setOpen(true);
  }, [state.setOpen]);
  return <span data-testid="status">{state.status}</span>;
}

describe("surface-specific query dispatch", () => {
  it("sends the suite fan-out width as planCount", async () => {
    render(<SuiteProbe planCount={3} />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    expect(queryCalls[0].name).toBe(RUN_COST_ESTIMATE_QUERIES.suite);
    expect(queryCalls[0].args).toEqual({ suiteId: "suite-1", planCount: 3 });
  });

  it("forwards the iteration override so the estimate matches the launch", async () => {
    render(<SuiteProbe planCount={1} iterationOverride={5} />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    expect(queryCalls[0].args).toEqual({
      suiteId: "suite-1",
      planCount: 1,
      iterationOverride: 5,
    });
  });

  it("re-fetches when the plan count changes (host/env attach edits)", async () => {
    const { rerender } = render(<SuiteProbe planCount={1} />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    rerender(<SuiteProbe planCount={4} />);
    await waitFor(() => expect(queryCalls).toHaveLength(2));
    expect((queryCalls[1].args as { planCount: number }).planCount).toBe(4);
  });

  it("re-fetches an open journey estimate when the journey config changes", async () => {
    // The query only takes `journeyId` and resolves targets server-side, so the
    // config signature is the only thing that can invalidate an open tooltip
    // after someone edits the journey's targets / sessions / turns.
    const { rerender } = render(<JourneyProbe configKey="env-1|2|3" />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    expect(queryCalls[0].args).toEqual({ journeyId: "journey-1" });

    rerender(<JourneyProbe configKey="env-1,env-2|2|3" />);
    await waitFor(() => expect(queryCalls).toHaveLength(2));
    // The args are unchanged by design — the signature only drives the refetch.
    expect(queryCalls[1].args).toEqual({ journeyId: "journey-1" });
  });

  it("does not re-fetch when the journey config signature is unchanged", async () => {
    const { rerender } = render(<JourneyProbe configKey="env-1|2|3" />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    rerender(<JourneyProbe configKey="env-1|2|3" />);
    await Promise.resolve();
    expect(queryCalls).toHaveLength(1);
  });

  it("sends the journey estimate under the registered Swarms query name", async () => {
    render(<JourneyProbe />);
    await waitFor(() => expect(queryCalls).toHaveLength(1));
    expect(queryCalls[0].name).toBe("journeyRuns:estimateJourneyRunCredits");
    expect(RUN_COST_ESTIMATE_QUERIES.journey).toBe(
      "journeyRuns:estimateJourneyRunCredits",
    );
    expect(queryCalls[0].args).toEqual({ journeyId: "journey-1" });
  });
});
