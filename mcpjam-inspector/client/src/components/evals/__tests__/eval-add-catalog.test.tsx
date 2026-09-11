import { expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { EVAL_ADD_CATALOG } from "../eval-add-catalog";
import {
  PREDICATE_KIND_LABELS,
  blankPredicate,
} from "@/shared/predicate-kinds";
import { WIDGET_ASSERTION_LABELS } from "@/shared/steps";
import { EvalAddDrawer } from "@/components/evaluate/case-spine/assertion-drawer";
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
afterEach(cleanup);
it("covers every predicate, widget assertion, action and outcome once, each with an icon", () => {
  expect(EVAL_ADD_CATALOG).toHaveLength(36);
  expect(new Set(EVAL_ADD_CATALOG.map((e) => e.key)).size).toBe(36);
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
    11,
  );
  for (const entry of EVAL_ADD_CATALOG.filter((e) => e.advisory)) {
    if (entry.choice.kind === "check")
      expect(blankPredicate(entry.choice.predicateKind).role).toBe("advisory");
  }
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
  fireEvent.change(screen.getByLabelText("Filter steps and checks"), {
    target: { value: "schema" },
  });
  const unsupported = screen.getByTestId(
    "add-step-item-check:toolResultMatchesSchema",
  );
  expect(unsupported).toBeDisabled();
  fireEvent.click(unsupported);
  expect(onSelect).not.toHaveBeenCalled();
});
