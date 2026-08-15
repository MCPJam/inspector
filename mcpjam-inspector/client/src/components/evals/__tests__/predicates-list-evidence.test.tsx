import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PredicateResult } from "@/shared/eval-matching";
import type { EvalTraceWidgetRenderObservationView } from "@/shared/eval-trace";
import { PredicatesList } from "../predicates-list";

const obs = (
  o: Partial<EvalTraceWidgetRenderObservationView> = {},
): EvalTraceWidgetRenderObservationView => ({
  toolCallId: "tc-search",
  toolName: "search-products",
  promptIndex: 0,
  status: "rendered",
  screenshotUrl: "https://store.example/obs.png",
  elapsedMs: 1581,
  ts: 1,
  ...o,
});

const row = (predicate: PredicateResult["predicate"]): PredicateResult => ({
  predicate,
  passed: true,
  reason: "widget rendered (1/1 observation(s))",
});

describe("PredicatesList — render-observation evidence", () => {
  it("shows the rendered widget card under a widgetRendered check", () => {
    render(
      <PredicatesList
        predicates={[row({ type: "widgetRendered" })]}
        observations={[obs()]}
      />,
    );
    const evidence = screen.getByTestId("predicate-render-evidence");
    expect(within(evidence).getByText("Rendered widget")).toBeInTheDocument();
    expect(
      within(evidence).getByTestId("render-observation-card"),
    ).toBeInTheDocument();
  });

  it("scopes evidence to the predicate's toolName", () => {
    render(
      <PredicatesList
        predicates={[row({ type: "widgetRendered", toolName: "view-cart" })]}
        observations={[
          obs({ toolCallId: "tc-1", toolName: "search-products" }),
          obs({ toolCallId: "tc-2", toolName: "view-cart" }),
        ]}
      />,
    );
    const cards = screen.getAllByTestId("render-observation-card");
    expect(cards).toHaveLength(1);
    expect(screen.getByText("view-cart")).toBeInTheDocument();
    expect(screen.queryByText("search-products")).toBeNull();
  });

  it("shows all rendered widgets when the check is unscoped (All widgets)", () => {
    render(
      <PredicatesList
        predicates={[row({ type: "widgetRendered" })]}
        observations={[
          obs({ toolCallId: "tc-1", toolName: "search-products" }),
          obs({ toolCallId: "tc-2", toolName: "view-cart" }),
        ]}
      />,
    );
    expect(screen.getByText("2 rendered widgets")).toBeInTheDocument();
    expect(screen.getAllByTestId("render-observation-card")).toHaveLength(2);
  });

  it("does not attach evidence to non-widget predicates", () => {
    render(
      <PredicatesList
        predicates={[row({ type: "noToolErrors" })]}
        observations={[obs()]}
      />,
    );
    expect(screen.queryByTestId("predicate-render-evidence")).toBeNull();
  });

  it("renders the row without evidence when observations are absent", () => {
    render(
      <PredicatesList predicates={[row({ type: "widgetRendered" })]} />,
    );
    expect(screen.queryByTestId("predicate-render-evidence")).toBeNull();
    // The verdict itself still renders — titled with the shared human label,
    // never the raw `widgetRendered` discriminator.
    expect(screen.getByText("View rendered")).toBeInTheDocument();
    expect(screen.queryByText("widgetRendered")).toBeNull();
  });

  it("titles a turn-scoped row with the SO-FAR variant, not the whole-run claim", () => {
    // A step-scoped `noToolErrors` was evaluated at one point in the flow. It
    // asserts nothing about the turns after it, so it must not borrow the
    // whole-run label.
    render(
      <PredicatesList
        predicates={[
          { ...row({ type: "noToolErrors" }), scope: { kind: "turn", promptIndex: 1 } },
        ]}
      />,
    );
    expect(screen.getByText("No tool errors so far")).toBeInTheDocument();
  });

  it("keeps the whole-run label for an unscoped row of the same kind", () => {
    render(<PredicatesList predicates={[row({ type: "noToolErrors" })]} />);
    expect(screen.getByText("No tool errors")).toBeInTheDocument();
    expect(screen.queryByText("No tool errors so far")).toBeNull();
  });

  it("renders a prototype-key discriminator as text instead of crashing", () => {
    // `parseIterationPredicates` only validates that `type` is a string, so a
    // corrupt or hostile metadata blob can carry `__proto__`. An unguarded map
    // lookup returns an inherited OBJECT, which throws when React renders it
    // as a child — taking the whole checks section down with it.
    render(
      <PredicatesList
        predicates={[row({ type: "__proto__" } as unknown as PredicateResult["predicate"])]}
      />,
    );
    expect(screen.getByText("__proto__")).toBeInTheDocument();
  });
});
