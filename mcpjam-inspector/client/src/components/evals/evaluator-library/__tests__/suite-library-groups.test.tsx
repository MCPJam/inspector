import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { SuiteScorerTable } from "../../suite-scorer-table";
import { clusterByEvaluator } from "../evaluator-stage-rows";
import {
  LIBRARY_EVALUATORS,
  taggedChecks,
  withEvaluatorUpdated,
  withoutEvaluator,
} from "../library-catalog";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (name: string) =>
    name === "evaluator-library" ? flag.on : true,
}));
vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));

const wasted = { id: "no-wasted-calls", version: 1 };
const tagged: Predicate[] = [
  { type: "noToolErrors" },
  { type: "toolCallCountUnder", count: 10, evaluator: wasted },
  { type: "noRepeatedIdenticalCall", evaluator: wasted },
];

function renderTable(predicates: Predicate[]) {
  const onPredicatesChange = vi.fn();
  render(
    <SuiteScorerTable
      matchOptions={undefined}
      scope={{ kind: "suite", predicates, onPredicatesChange }}
      judgeConfig={undefined}
      availableModels={[]}
      passOrFailHint=""
      judgeHint=""
    />,
  );
  const next = () => {
    const arg = onPredicatesChange.mock.calls.at(-1)?.[0];
    return typeof arg === "function" ? arg(predicates) : arg;
  };
  return { next };
}

describe("library groups in the suite table", () => {
  it("groups a library evaluator's checks and removes them together", () => {
    const { next } = renderTable(tagged);
    const groups = screen.getAllByRole("region", { name: "No Wasted Calls" });
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]).toHaveTextContent("v1");
    fireEvent.click(
      within(groups[0]).getByRole("button", { name: "Remove No Wasted Calls" }),
    );
    expect(next()).toEqual([{ type: "noToolErrors" }]);
  });

  it("hides the library on a deployment that cannot save any of it", () => {
    // No capabilities means a deployment that predates the kind list, which
    // accepts only the legacy kinds. Every library evaluator needs a newer
    // kind, so there is nothing to offer.
    renderTable([]);
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
  });

  it("shows no groups or library button with the flag off", () => {
    flag.on = false;
    renderTable(tagged);
    expect(
      screen.queryByRole("region", { name: "No Wasted Calls" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "From library" }),
    ).not.toBeInTheDocument();
    flag.on = true;
  });
});

describe("library catalog edits", () => {
  it("clusters rows by evaluator in first-appearance order", () => {
    const { loose, clusters } = clusterByEvaluator(tagged, (p) => p);
    expect(loose).toEqual([{ type: "noToolErrors" }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rows).toHaveLength(2);
  });

  it("removes and replaces only one evaluator's checks", () => {
    expect(withoutEvaluator(tagged, "no-wasted-calls")).toEqual([
      { type: "noToolErrors" },
    ]);
    const edited: Predicate[] = [
      { type: "noToolErrors" },
      { type: "toolCallCountUnder", count: 4, evaluator: wasted },
    ];
    const entry = LIBRARY_EVALUATORS.find((e) => e.id === "no-wasted-calls");
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(withEvaluatorUpdated(edited, "no-wasted-calls")).toEqual([
      { type: "noToolErrors" },
      ...taggedChecks(entry),
    ]);
    expect(withEvaluatorUpdated(edited, "unknown")).toEqual(edited);
  });
});
