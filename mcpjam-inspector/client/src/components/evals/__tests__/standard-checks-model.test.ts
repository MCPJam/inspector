import { expect, it } from "vitest";
import {
  STANDARD_ASSERTION_CHECKS,
  standardCheckState,
  toggleCaseStandardCheck,
  toggleSuiteStandardCheck,
} from "../standard-checks-model";
import type { Predicate } from "@/shared/eval-matching";
const check = STANDARD_ASSERTION_CHECKS.find(
  (check) => check.id === "response.performance",
)!;
const customized: Predicate = {
  type: "toolLatencyUnder",
  ms: 1234,
  role: "advisory",
};
const unrelated: Predicate = { type: "noToolErrors" };
it("customized thresholds and report severity remain enabled with source and count", () => {
  expect(
    standardCheckState(check, [customized, check.preset], {
      predicates: { mode: "extend", list: [customized] },
    }),
  ).toMatchObject({
    enabled: true,
    customized: true,
    suiteCount: 2,
    caseCount: 1,
  });
  expect(
    toggleSuiteStandardCheck([customized, unrelated], check, true),
  ).toEqual([customized, unrelated]);
  expect(
    toggleSuiteStandardCheck(
      [customized, check.preset, unrelated],
      check,
      false,
    ),
  ).toEqual([unrelated]);
});
it("off suppresses inherited family and removes local members; on restores edited suite defaults", () => {
  const off = toggleCaseStandardCheck(
    [customized, unrelated],
    { predicates: { mode: "extend", list: [check.preset, unrelated] } },
    check,
    false,
  );
  expect(off).toEqual({
    predicates: { mode: "extend", list: [unrelated] },
    suppressedSuiteStandardCheckIds: [check.id],
  });
  const changed: Predicate = { ...customized, ms: 9999 };
  const on = toggleCaseStandardCheck([changed, unrelated], off, check, true);
  expect(on.suppressedSuiteStandardCheckIds).toEqual([]);
  expect(on.predicates).toEqual({ mode: "extend", list: [unrelated] });
  expect(standardCheckState(check, [changed, unrelated], on).rules).toEqual([
    changed,
  ]);
});
it("preserves replace and inherit semantics and can remove the final local rule", () => {
  const off = toggleCaseStandardCheck(
    [],
    { predicates: { mode: "replace", list: [check.preset] } },
    check,
    false,
  );
  expect(off.predicates).toEqual({ mode: "replace", list: [] });
  expect(
    toggleCaseStandardCheck([customized], off, check, true).predicates,
  ).toEqual({ mode: "replace", list: [check.preset] });
  expect(
    toggleCaseStandardCheck(
      [],
      { predicates: { mode: "inherit", list: [unrelated] } },
      check,
      true,
    ).predicates,
  ).toEqual({ mode: "extend", list: [check.preset] });
});
