import { expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { ADD_SECTIONS, EVAL_ADD_CATALOG } from "../eval-add-catalog";
import {
  ASSERTION_STAGE,
  EVALUATOR_PRESENTATION_GROUP,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGES,
} from "@mcpjam/sdk/contract";
import {
  PREDICATE_KIND_LABELS,
  blankPredicate,
} from "@/shared/predicate-kinds";
import { WIDGET_ASSERTION_LABELS } from "@/shared/steps";
import { EvalAddDrawer } from "@/components/evaluate/case-spine/assertion-drawer";
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
afterEach(cleanup);
it("covers every predicate, widget assertion, action and outcome once, each with an icon", () => {
  expect(EVAL_ADD_CATALOG).toHaveLength(43);
  expect(new Set(EVAL_ADD_CATALOG.map((e) => e.key)).size).toBe(43);
  expect(
    EVAL_ADD_CATALOG.filter((e) => e.choice.kind === "check")
      .map((e) => e.key)
      .sort(),
  ).toEqual(
    Object.keys(PREDICATE_KIND_LABELS)
      .map((k) => `check:${k}`)
      .sort(),
  );
  expect(
    EVAL_ADD_CATALOG.filter((e) => e.choice.kind === "widget-check")
      .map((e) => e.key)
      .sort(),
  ).toEqual(
    Object.keys(WIDGET_ASSERTION_LABELS)
      .map((k) => `widget:${k}`)
      .sort(),
  );
  for (const entry of EVAL_ADD_CATALOG) expect(entry.Icon).toBeTruthy();
  expect(EVAL_ADD_CATALOG.filter((e) => e.scope === "whole-run")).toHaveLength(
    17,
  );
  for (const entry of EVAL_ADD_CATALOG.filter((e) => e.advisory)) {
    if (entry.choice.kind === "check")
      expect(blankPredicate(entry.choice.predicateKind).role).toBe("advisory");
  }
});
it("files every assertion under the chain stage the contract reports it at", () => {
  // The heading a reader picks an assertion from must be the heading its
  // evidence appears under on the run page. `ASSERTION_STAGE` is the contract
  // for that; budgets are the one presentation group it carries. Sections run
  // in chain order so the drawer reads like the funnel.
  const stageSection = (stage: keyof typeof USER_VALUE_STAGE_LABELS) =>
    `Assertions · ${USER_VALUE_STAGE_LABELS[stage]}`;
  expect(ADD_SECTIONS).toEqual([
    "Actions",
    ...USER_VALUE_STAGES.filter((stage) => stage !== "connection").map(
      stageSection,
    ),
    "Assertions · Budgets",
  ]);
  for (const entry of EVAL_ADD_CATALOG) {
    if (entry.choice.kind === "step") {
      expect(entry.section).toBe("Actions");
      continue;
    }
    if (entry.choice.kind !== "check") {
      // Widget assertions and the expected outcome grade what the person saw.
      expect(entry.section).toBe(stageSection("userValue"));
      continue;
    }
    const kind = entry.choice.predicateKind;
    expect(entry.section, kind).toBe(
      EVALUATOR_PRESENTATION_GROUP[kind] === "budget"
        ? "Assertions · Budgets"
        : stageSection(ASSERTION_STAGE[kind]),
    );
  }
  expect(ADD_SECTIONS.join(" ")).not.toMatch(/check|observation|limit/i);
});
it("shows all sections and retains unsupported entries in search without allowing selection", () => {
  const onSelect = vi.fn();
  render(
    <EvalAddDrawer
      onSelect={onSelect}
      authorableKinds={["responseContains", "widgetRendered"]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getAllByRole("region")).toHaveLength(7);
  expect(
    screen.getByTestId("add-step-item-check:widgetRendered"),
  ).toBeDisabled();
  expect(
    screen.getByTestId("add-step-item-widget:widgetToolCalled"),
  ).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Filter steps and assertions"), {
    target: { value: "schema" },
  });
  const unsupported = screen.getByTestId(
    "add-step-item-check:toolResultMatchesSchema",
  );
  expect(unsupported).toBeDisabled();
  fireEvent.click(unsupported);
  expect(onSelect).not.toHaveBeenCalled();
});
