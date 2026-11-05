import { describe, expect, it } from "vitest";
import { resolveEvaluateRedirect } from "../evaluate-legacy-paths";

const S = "/evaluate/suite/s_1";

function resolve(url: string, navEnabled: boolean | undefined) {
  const parsed = new URL(url, "https://app.test");
  return resolveEvaluateRedirect({
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    navEnabled,
  });
}

/**
 * The spec's URL table (C15), one row per old form. `back` is where the new
 * address goes with the flag off: today's page from the nav page map.
 */
const LEGACY_ROWS = [
  {
    fromKind: "suite-test-cases",
    old: `${S}?view=test-cases`,
    next: `${S}/settings/cases`,
    toKind: "suite-settings",
    back: `${S}?view=test-cases`,
    backKind: "suite-overview",
  },
  {
    fromKind: "suite-edit",
    old: `${S}/edit`,
    next: `${S}/settings`,
    toKind: "suite-settings",
    back: `${S}/edit`,
    backKind: "suite-edit",
  },
  {
    fromKind: "suite-edit-from-case-checks",
    old: `${S}/edit?fromCaseChecks=c_1`,
    next: `${S}/settings/evaluators`,
    toKind: "suite-settings",
    back: `${S}/edit`,
    backKind: "suite-edit",
  },
  {
    fromKind: "case-draft-describe",
    old: `${S}/test/draft%3Adescribe/edit`,
    next: `${S}/settings/cases/new`,
    toKind: "case-new",
    back: `${S}/test/draft%3Adescribe/edit`,
    backKind: "test-edit",
  },
  {
    fromKind: "case-edit",
    old: `${S}/test/c_1/edit`,
    next: `${S}/settings/cases/c_1`,
    toKind: "case-settings",
    back: `${S}/test/c_1/edit`,
    backKind: "test-edit",
  },
  {
    fromKind: "case-edit-checks",
    old: `${S}/test/c_1/edit?checks=1`,
    next: `${S}/settings/cases/c_1/evaluators`,
    toKind: "case-evaluators",
    back: `${S}/test/c_1/edit?checks=1`,
    backKind: "test-edit",
  },
  {
    fromKind: "case-edit-compare",
    old: `${S}/test/c_1/edit?compare=1&iteration=i_1`,
    next: `${S}/settings/cases/c_1`,
    toKind: "case-settings",
    back: `${S}/test/c_1/edit`,
    backKind: "test-edit",
  },
  {
    fromKind: "case-detail",
    old: `${S}/test/c_1`,
    next: `${S}/settings/cases/c_1`,
    toKind: "case-settings",
    back: `${S}/test/c_1/edit`,
    backKind: "test-edit",
  },
  {
    fromKind: "run-case",
    old: `${S}/runs/r_1?case=c_1`,
    next: `${S}/runs/r_1/cases/c_1`,
    toKind: "test-run",
    back: `${S}/runs/r_1?case=c_1`,
    backKind: "run-detail",
  },
  {
    fromKind: "run-case-iteration",
    old: `${S}/runs/r_1?case=c_1&iteration=i_1`,
    next: `${S}/runs/r_1/cases/c_1/iter/i_1`,
    toKind: "iteration",
    back: `${S}/runs/r_1?iteration=i_1&case=c_1`,
    backKind: "run-detail",
  },
];

/** New addresses with no old form of their own. */
const NEW_ONLY_ROWS = [
  {
    next: "/evaluate/runs",
    kind: "evaluate-runs",
    back: "/evaluate",
    backKind: "list",
  },
  {
    next: `${S}/runs/r_1/cases/c_1/edit`,
    kind: "test-run-edit",
    back: `${S}/test/c_1/edit`,
    backKind: "test-edit",
  },
  {
    next: `${S}/runs/r_1/cases/c_1?target=m_2`,
    kind: "test-run",
    back: `${S}/runs/r_1?case=c_1`,
    backKind: "run-detail",
  },
];

describe("old Evaluate addresses with the flag on", () => {
  it.each(LEGACY_ROWS)("$fromKind: $old → $next", (row) => {
    expect(resolve(row.old, true)).toEqual({
      kind: "redirect",
      to: row.next,
      event: { from_kind: row.fromKind, to_kind: row.toKind, matched: true },
    });
    expect(resolve(row.next, true)).toEqual({ kind: "stay" });
  });

  it("opens the suite run for an iteration link without its case, unmatched", () => {
    expect(resolve(`${S}/runs/r_1?iteration=i_1`, true)).toEqual({
      kind: "redirect",
      to: `${S}/runs/r_1`,
      event: {
        from_kind: "run-iteration",
        to_kind: "run-detail",
        matched: false,
      },
    });
  });
});

describe("new Evaluate addresses with the flag off", () => {
  it.each(LEGACY_ROWS)("$toKind: $next → $back", (row) => {
    expect(resolve(row.next, false)).toEqual({
      kind: "redirect",
      to: row.back,
      event: { from_kind: row.toKind, to_kind: row.backKind, matched: true },
    });
    expect(resolve(row.old, false)).toEqual({ kind: "stay" });
  });

  it.each(NEW_ONLY_ROWS)("$kind: $next → $back", (row) => {
    expect(resolve(row.next, false)).toEqual({
      kind: "redirect",
      to: row.back,
      event: { from_kind: row.kind, to_kind: row.backKind, matched: true },
    });
    expect(resolve(row.next, true)).toEqual({ kind: "stay" });
  });
});

describe("addresses that do not move", () => {
  it.each([
    "/evaluate",
    "/evaluate/create",
    S,
    `${S}?view=executions`,
    `${S}/runs/r_1`,
    `${S}/runs/r_1/compare?compareTo=r_0`,
    `${S}/test/c_1/edit?fromEvalServer=srv_1`,
    `${S}/test/draft%3Aprompt/edit`,
    "/evals/suite/s_1/edit",
    "/servers",
  ])("%s stays under either flag value", (url) => {
    expect(resolve(url, true)).toEqual({ kind: "stay" });
    expect(resolve(url, false)).toEqual({ kind: "stay" });
    expect(resolve(url, undefined)).toEqual({ kind: "stay" });
  });

  it("waits for the flag on an address that redirects under one value", () => {
    expect(resolve(`${S}/edit`, undefined)).toEqual({ kind: "wait" });
    expect(resolve(`${S}/settings`, undefined)).toEqual({ kind: "wait" });
  });
});

describe("unmatched Evaluate addresses", () => {
  it.each([
    [`${S}/history/r_9`, "evaluate/suite/:id/:id/:id"],
    [
      `${S}/settings/cases/c_1/runs`,
      "evaluate/suite/:id/settings/cases/:id/runs",
    ],
    ["/evaluate/overview", "evaluate/:id"],
  ])("%s is recorded with its shape, ids removed", (url, shape) => {
    for (const navEnabled of [true, false, undefined]) {
      expect(resolve(url, navEnabled)).toEqual({
        kind: "unmatched",
        event: { from_kind: shape, to_kind: "list", matched: false },
      });
    }
  });
});

describe("what a redirect keeps", () => {
  it("carries query keys the route does not own, and the hash", () => {
    expect(
      resolve(`${S}/runs/r_1?case=c_1&project=P#trace`, true),
    ).toMatchObject({
      to: `${S}/runs/r_1/cases/c_1?project=P#trace`,
    });
    expect(
      resolve(`${S}/runs/r_1/cases/c_1?target=m_2&project=P`, false),
    ).toMatchObject({ to: `${S}/runs/r_1?case=c_1&project=P` });
  });

  it("encodes ids in the new path", () => {
    expect(
      resolve("/evaluate/suite/s%201/test/c%2F1/edit", true),
    ).toMatchObject({
      to: "/evaluate/suite/s%201/settings/cases/c%2F1",
    });
  });
});
