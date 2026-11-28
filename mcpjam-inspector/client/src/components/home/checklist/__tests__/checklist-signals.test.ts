import { describe, expect, it } from "vitest";
import type { ConformanceRunListItem } from "@/components/conformance/ConformanceHistory";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import { computeChecklistSignals } from "../checklist-signals";
import { normalizeHomeChecklistVariant } from "../use-home-checklist-variant";

const run = (over: Partial<ConformanceRunListItem>) =>
  ({
    _id: "run-1",
    status: "completed",
    createdAt: 1,
    passed: 7,
    applicable: 9,
    ...over,
  }) as ConformanceRunListItem;

const suite = (
  createdBy: string,
  latestRun: Partial<NonNullable<EvalSuiteOverviewEntry["latestRun"]>> | null,
) =>
  ({
    suite: { _id: `suite-${createdBy}`, createdBy },
    latestRun,
  }) as EvalSuiteOverviewEntry;

const base = {
  hasServer: false,
  hasPlaygroundChat: false,
  progress: {},
  userId: "me",
  conformanceRuns: [],
  suites: [],
};

describe("computeChecklistSignals", () => {
  it("checks nothing for a new user", () => {
    const { done } = computeChecklistSignals(base);
    expect(Object.values(done).every((value) => !value)).toBe(true);
  });

  it("checks Connect for a user who already has a server", () => {
    expect(
      computeChecklistSignals({ ...base, hasServer: true }).done.connect,
    ).toBe(true);
  });

  it("checks Playground for a conversation from before the checklist", () => {
    expect(
      computeChecklistSignals({ ...base, hasPlaygroundChat: true }).done.chat,
    ).toBe(true);
  });

  it("checks the agent step when added or skipped", () => {
    expect(
      computeChecklistSignals({ ...base, progress: { agent: true } }).done
        .onboard_agent,
    ).toBe(true);
    expect(
      computeChecklistSignals({ ...base, progress: { skippedAgent: true } })
        .done.onboard_agent,
    ).toBe(true);
  });

  it("counts a finished conformance run, failing checks included", () => {
    const signals = computeChecklistSignals({
      ...base,
      conformanceRuns: [
        run({ _id: "old", createdAt: 1, failed: 3 } as never),
        run({ _id: "new", createdAt: 2 }),
        run({ _id: "live", createdAt: 3, status: "running" }),
      ],
    });
    expect(signals.done.check_server).toBe(true);
    expect(signals.conformance.run?._id).toBe("new");
  });

  it("ignores another member's conformance run", () => {
    const signals = computeChecklistSignals({
      ...base,
      conformanceRuns: [run({ createdBy: "teammate" } as never)],
    });
    expect(signals.done.check_server).toBe(false);
  });

  it("opens the user's unrun suite and only counts their finished run", () => {
    const unrun = computeChecklistSignals({
      ...base,
      suites: [suite("teammate", { status: "completed", createdBy: "teammate" }), suite("me", null)],
    });
    expect(unrun.done.create_eval).toBe(false);
    expect(unrun.eval.suiteId).toBe("suite-me");

    const ran = computeChecklistSignals({
      ...base,
      suites: [
        suite("me", {
          status: "completed",
          createdBy: "me",
          summary: { total: 10, passed: 8, failed: 2, passRate: 0.8 },
        }),
      ],
    });
    expect(ran.done.create_eval).toBe(true);
    expect(ran.eval.passRate).toBe(0.8);
  });

  it("keeps the eval step done when a later run is still going", () => {
    const entry = {
      ...suite("me", { status: "running", createdBy: "me" }),
      recentRuns: [
        { status: "running", createdBy: "me" },
        {
          status: "completed",
          createdBy: "me",
          summary: { total: 4, passed: 3, failed: 1, passRate: 0.75 },
        },
      ],
    } as EvalSuiteOverviewEntry;
    const signals = computeChecklistSignals({ ...base, suites: [entry] });
    expect(signals.done.create_eval).toBe(true);
    expect(signals.eval.passRate).toBe(0.75);
  });
});

describe("normalizeHomeChecklistVariant", () => {
  it.each([
    ["treatment", "treatment"],
    [true, "treatment"],
    ["control", "control"],
    [false, "control"],
    [undefined, "control"],
  ] as const)("maps %s to %s", (raw, expected) => {
    expect(normalizeHomeChecklistVariant(raw)).toBe(expected);
  });
});
