import { expect, it } from "vitest";
import {
  STANDARD_ASSERTION_CHECKS,
  addCaseRule,
  listEffectiveRules,
  removeCaseRule,
  setSuiteFamilySuppressed,
  toggleCaseStandardCheck,
  toggleSuiteStandardCheck,
  updateCaseRule,
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
it("lists suite rules then case rules, marking a suppressed family and honouring the mode", () => {
  expect(listEffectiveRules([customized, unrelated])).toEqual([
    { predicate: customized, source: "suite", index: 0, suppressed: false },
    { predicate: unrelated, source: "suite", index: 1, suppressed: false },
  ]);
  expect(
    listEffectiveRules([customized, unrelated], {
      predicates: { mode: "extend", list: [check.preset] },
      suppressedSuiteStandardCheckIds: [check.id],
    }),
  ).toEqual([
    { predicate: customized, source: "suite", index: 0, suppressed: true },
    { predicate: unrelated, source: "suite", index: 1, suppressed: false },
    { predicate: check.preset, source: "case", index: 0, suppressed: false },
  ]);
  // Replace drops the suite's rules; inherit drops the case's list.
  expect(
    listEffectiveRules([customized], {
      predicates: { mode: "replace", list: [unrelated] },
    }).map((rule) => rule.source),
  ).toEqual(["case"]);
  expect(
    listEffectiveRules([customized], {
      predicates: { mode: "inherit", list: [unrelated] },
    }).map((rule) => rule.source),
  ).toEqual(["suite"]);
});
it("edits the case list in place and keeps the mode", () => {
  const inheriting = addCaseRule({}, unrelated);
  expect(inheriting).toEqual({
    predicates: { mode: "extend", list: [unrelated] },
    suppressedSuiteStandardCheckIds: [],
  });
  const replacing = addCaseRule(
    { predicates: { mode: "replace", list: [customized] } },
    unrelated,
  );
  expect(replacing.predicates).toEqual({
    mode: "replace",
    list: [customized, unrelated],
  });
  expect(updateCaseRule(replacing, 1, check.preset).predicates).toEqual({
    mode: "replace",
    list: [customized, check.preset],
  });
  expect(removeCaseRule(replacing, 0).predicates).toEqual({
    mode: "replace",
    list: [unrelated],
  });
  // Suppression already on the draft rides along untouched.
  expect(
    addCaseRule({ suppressedSuiteStandardCheckIds: [check.id] }, unrelated)
      .suppressedSuiteStandardCheckIds,
  ).toEqual([check.id]);
});
it("suppresses and restores one suite family without touching the case list", () => {
  const draft = { predicates: { mode: "extend" as const, list: [unrelated] } };
  const off = setSuiteFamilySuppressed(draft, check.id, true);
  expect(off).toEqual({
    predicates: draft.predicates,
    suppressedSuiteStandardCheckIds: [check.id],
  });
  expect(setSuiteFamilySuppressed(off, check.id, false)).toEqual({
    predicates: draft.predicates,
    suppressedSuiteStandardCheckIds: [],
  });
});
it("suite toggle adds the preset only when the family is absent and removes every member", () => {
  expect(
    toggleSuiteStandardCheck([customized, unrelated], check, true),
  ).toEqual([customized, unrelated]);
  expect(toggleSuiteStandardCheck([unrelated], check, true)).toEqual([
    unrelated,
    check.preset,
  ]);
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
  expect(
    listEffectiveRules([changed, unrelated], on)
      .filter((rule) => rule.predicate.type === check.preset.type)
      .map((rule) => rule.predicate),
  ).toEqual([changed]);
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
