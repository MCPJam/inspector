import { describe, expect, it } from "vitest";
import {
  LEGACY_EVAL_FORMS,
  evaluateAddressDependsOnFlag,
  planEvaluateAddress,
  type EvaluateAddressPlan,
  type IterationLocation,
  type LegacyEvalForm,
} from "../evaluate-legacy-paths";

const E = "/evaluate/suite/S";
const PROJECT = "/p/k5700000000000000000000000a";

function parts(href: string) {
  const url = new URL(href, "https://app.test");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

function plan(href: string, navEnabled: boolean) {
  return planEvaluateAddress(parts(href), navEnabled);
}

function afterLookup(
  result: EvaluateAddressPlan,
  found: IterationLocation | null,
): EvaluateAddressPlan {
  if (result.action !== "lookup")
    throw new Error(`no lookup: ${result.action}`);
  return result.resolve(found);
}

type OldRow = {
  form: LegacyEvalForm;
  from: string;
  to: string;
  toKind: string;
  /** What `getTestIteration` answers, for forms that look the iteration up. */
  found?: IterationLocation;
};

/** The spec's "Today" URLs and the other forms Evaluate links still use. */
const OLD_TO_NEW: OldRow[] = [
  {
    form: "suite-edit",
    from: `${E}/edit`,
    to: `${E}/settings`,
    toKind: "suite-settings",
  },
  {
    form: "suite-edit-from-case-checks",
    from: `${E}/edit?fromCaseChecks=C`,
    to: `${E}/settings/evaluators`,
    toKind: "suite-settings",
  },
  {
    form: "suite-test-cases-view",
    from: `${E}?view=test-cases`,
    to: `${E}/settings/cases`,
    toKind: "suite-settings",
  },
  {
    form: "case-draft",
    from: `${E}/test/draft%3Adescribe/edit`,
    to: `${E}/settings/cases/new`,
    toKind: "case-new",
  },
  {
    form: "case-edit",
    from: `${E}/test/C/edit`,
    to: `${E}/settings/cases/C`,
    toKind: "case-settings",
  },
  {
    form: "case-detail",
    from: `${E}/test/C`,
    to: `${E}/settings/cases/C`,
    toKind: "case-settings",
  },
  {
    form: "case-checks",
    from: `${E}/test/C/edit?checks=1`,
    to: `${E}/settings/cases/C/evaluators`,
    toKind: "case-evaluators",
  },
  {
    form: "case-compare",
    from: `${E}/test/C/edit?compare=1`,
    to: `${E}/settings/cases/C`,
    toKind: "case-settings",
  },
  {
    form: "case-iteration",
    from: `${E}/test/C/edit?compare=1&iteration=I`,
    found: { testCaseId: "C", suiteRunId: "R" },
    to: `${E}/runs/R/cases/C/iter/I`,
    toKind: "iteration",
  },
  {
    form: "run-case",
    from: `${E}/runs/R?case=C`,
    to: `${E}/runs/R/cases/C`,
    toKind: "test-run",
  },
  {
    form: "run-iteration",
    from: `${E}/runs/R?iteration=I&case=C`,
    to: `${E}/runs/R/cases/C/iter/I`,
    toKind: "iteration",
  },
  {
    form: "run-iteration-no-case",
    from: `${E}/runs/R?iteration=I`,
    found: { testCaseId: "C", suiteRunId: "R" },
    to: `${E}/runs/R/cases/C/iter/I`,
    toKind: "iteration",
  },
];

describe("old Evaluate addresses with the flag on", () => {
  it("covers every row of the table", () => {
    expect(OLD_TO_NEW.map((row) => row.form).sort()).toEqual(
      LEGACY_EVAL_FORMS.map((row) => row.form).sort(),
    );
  });

  it.each(OLD_TO_NEW)(
    "$form: $from → $to",
    ({ form, from, to, toKind, found }) => {
      const first = plan(from, true);
      const result = found ? afterLookup(first, found) : first;
      expect(result).toEqual({
        action: "redirect",
        to,
        event: { from_kind: form, to_kind: toKind, matched: true },
      });
    },
  );

  it.each(OLD_TO_NEW)(
    "$form keeps the project, ?project= and the fragment",
    (row) => {
      const first = plan(
        `${PROJECT}${row.from}${row.from.includes("?") ? "&" : "?"}project=P#trace`,
        true,
      );
      const result = row.found ? afterLookup(first, row.found) : first;
      expect(result).toMatchObject({
        action: "redirect",
        to: `${PROJECT}${row.to}${row.to.includes("?") ? "&" : "?"}project=P#trace`,
      });
    },
  );

  // The flag-off direction is the nav page map's `todayRoute`; a round trip
  // through it lands on the same page kind.
  it.each(OLD_TO_NEW)(
    "$form survives a round trip through today's page",
    (row) => {
      const first = plan(row.from, true);
      const result = row.found ? afterLookup(first, row.found) : first;
      if (result.action !== "redirect") throw new Error("expected a redirect");
      const back = plan(result.to, false);
      if (back.action !== "redirect") throw new Error("expected a way back");
      expect(plan(back.to, true)).toMatchObject({
        action: "redirect",
        event: { to_kind: row.toKind },
      });
    },
  );
});

describe("old addresses the table cannot finish", () => {
  it.each<[string, string, IterationLocation | null, string]>([
    ["run-iteration-no-case", `${E}/runs/R?iteration=I`, null, "run-detail"],
    [
      "run-iteration-no-case",
      `${E}/runs/R?iteration=I`,
      { suiteRunId: "R" },
      "run-detail",
    ],
    ["case-iteration", `${E}/test/C/edit?iteration=I`, null, "test-edit"],
    [
      "case-iteration",
      `${E}/test/C/edit?compare=1&iteration=I`,
      { testCaseId: "C" },
      "test-edit",
    ],
  ])(
    "%s (%s, found %o) stays and reports matched: false",
    (form, from, found, toKind) => {
      expect(afterLookup(plan(from, true), found)).toEqual({
        action: "stay",
        event: { from_kind: form, to_kind: toKind, matched: false },
      });
    },
  );

  it("looks up the iteration named by the address", () => {
    expect(plan(`${E}/runs/R?iteration=I`, true)).toMatchObject({
      action: "lookup",
      iterationId: "I",
    });
  });
});

describe("new Evaluate addresses with the flag off", () => {
  it.each<[string, string, string, string]>([
    ["evaluate-runs", "/evaluate/runs", "/evaluate", "list"],
    ["suite-settings", `${E}/settings`, `${E}/edit`, "suite-edit"],
    ["suite-settings", `${E}/settings/evaluators`, `${E}/edit`, "suite-edit"],
    [
      "suite-settings",
      `${E}/settings/cases`,
      `${E}?view=test-cases`,
      "suite-overview",
    ],
    [
      "case-new",
      `${E}/settings/cases/new`,
      `${E}/test/draft%3Adescribe/edit`,
      "test-edit",
    ],
    ["case-settings", `${E}/settings/cases/C`, `${E}/test/C/edit`, "test-edit"],
    [
      "case-evaluators",
      `${E}/settings/cases/C/evaluators`,
      `${E}/test/C/edit?checks=1`,
      "test-edit",
    ],
    [
      "test-run",
      `${E}/runs/R/cases/C?target=m`,
      `${E}/runs/R?case=C`,
      "run-detail",
    ],
    [
      "iteration",
      `${E}/runs/R/cases/C/iter/I`,
      `${E}/runs/R?iteration=I&case=C`,
      "run-detail",
    ],
    [
      "test-run-edit",
      `${E}/runs/R/cases/C/edit`,
      `${E}/test/C/edit`,
      "test-edit",
    ],
  ])("%s: %s → %s", (fromKind, from, to, toKind) => {
    expect(plan(from, false)).toEqual({
      action: "redirect",
      to,
      event: { from_kind: fromKind, to_kind: toKind, matched: true },
    });
  });
});

describe("addresses that stay", () => {
  it.each([
    "/evaluate",
    "/evaluate/create",
    "/evaluate/eval-server/srv",
    E,
    `${E}?view=executions`,
    `${E}/runs/R`,
    `${E}/runs/R?compareTo=R2&insights=1`,
    `${E}/runs/R/compare?case=C`,
    `${E}/test/draft%3Aprompt/edit`,
    `${E}/test/draft%3Arecord/edit`,
    `${E}/test/C/edit?fromEvalServer=srv`,
    "/evals/suite/S/edit",
    "/servers",
  ])("%s with the flag on", (href) => {
    expect(plan(href, true)).toEqual({ action: "stay" });
  });

  it.each([`${E}/settings`, `${E}/runs/R/cases/C`, "/evaluate/runs"])(
    "new address %s with the flag on",
    (href) => {
      expect(plan(href, true)).toEqual({ action: "stay" });
    },
  );

  it.each([`${E}/edit`, `${E}/runs/R?case=C`, "/evaluate", `${E}/runs/R`])(
    "today's address %s with the flag off",
    (href) => {
      expect(plan(href, false)).toEqual({ action: "stay" });
    },
  );
});

describe("evaluateAddressDependsOnFlag", () => {
  it.each([
    [`${E}/edit`, true],
    [`${E}/settings`, true],
    [`${E}/runs/R?iteration=I`, true],
    [`${E}/runs/R`, false],
    ["/evaluate", false],
  ])("%s → %s", (href, expected) => {
    expect(evaluateAddressDependsOnFlag(parts(href))).toBe(expected);
  });
});
