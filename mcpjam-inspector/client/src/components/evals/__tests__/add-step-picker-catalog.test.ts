import { describe, expect, it } from "vitest";
import {
  PICKER_CATALOG,
  catalogPredicateKinds,
  catalogStepKinds,
  catalogWidgetCheckKinds,
  primaryItems,
  secondaryCount,
  secondaryItems,
} from "../add-step-picker-catalog";
import {
  isScenarioPredicateKind,
  PREDICATE_KIND_ORDER,
} from "@/shared/predicate-kinds";

const EXPECTED_STEP_KINDS = ["prompt", "interact", "toolCall"] as const;

const EXPECTED_WIDGET_CHECK_KINDS = [
  "textVisible",
  "elementVisible",
  "elementHidden",
  "inputValue",
] as const;

describe("add-step-picker-catalog integrity", () => {
  it("covers every scenario predicate kind exactly once", () => {
    const expected = PREDICATE_KIND_ORDER.filter(isScenarioPredicateKind);
    const actual = catalogPredicateKinds();

    expect(actual).toHaveLength(expected.length);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("does not reference non-scenario predicate kinds", () => {
    for (const kind of catalogPredicateKinds()) {
      expect(isScenarioPredicateKind(kind)).toBe(true);
    }
  });

  it("has no duplicate catalog keys", () => {
    const keys = PICKER_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers all drive step kinds", () => {
    expect([...catalogStepKinds()].sort()).toEqual(
      [...EXPECTED_STEP_KINDS].sort(),
    );
  });

  it("covers all inline widget-check kinds (excluding widgetToolCalled)", () => {
    expect([...catalogWidgetCheckKinds()].sort()).toEqual(
      [...EXPECTED_WIDGET_CHECK_KINDS].sort(),
    );
  });

  it("has 6 primary items and 12 secondary items", () => {
    expect(primaryItems()).toHaveLength(6);
    expect(secondaryItems()).toHaveLength(12);
    expect(secondaryCount()).toBe(12);
  });

  it("places widgetNoConsoleErrors under viewLifecycle, not transcript", () => {
    const entry = PICKER_CATALOG.find(
      (e) =>
        e.choice.kind === "check" &&
        e.choice.predicateKind === "widgetNoConsoleErrors",
    );
    expect(entry?.group).toBe("viewLifecycle");
    expect(entry?.tier).toBe("secondary");
  });
});
