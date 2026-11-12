import { describe, expect, it } from "vitest";
import type { EvalRoute } from "../eval-route-types";
import {
  matchLegacyEvaluatePath,
  redirectForIteration,
  type LegacyEvaluateMatch,
  type LegacyIterationLookup,
} from "../evaluate-legacy-paths";

const S = "/evaluate/suite/S";
const KEEP: LegacyEvaluateMatch = { kind: "keep" };
const UNMATCHED: LegacyEvaluateMatch = { kind: "unmatched" };

function to(
  fromKind: EvalRoute["type"],
  route: EvalRoute,
  path: string,
  backTo?: EvalRoute,
): LegacyEvaluateMatch {
  return {
    kind: "redirect",
    redirect: { fromKind, to: route, path, ...(backTo ? { backTo } : {}) },
  };
}

function lookup(
  fromKind: LegacyIterationLookup["fromKind"],
  iterationId: string,
  runId: string | null,
  fallback: EvalRoute,
): LegacyEvaluateMatch {
  return {
    kind: "lookup",
    lookup: { fromKind, suiteId: "S", iterationId, runId, fallback },
  };
}

const caseSettings = (id: string): EvalRoute => ({
  type: "case-settings",
  suiteId: "S",
  testCaseId: id,
});
const casesTab: EvalRoute = {
  type: "suite-settings",
  suiteId: "S",
  tab: "cases",
};

const ROWS: Array<[string, string, string, LegacyEvaluateMatch]> = [
  ["1 root", "/evaluate", "", KEEP],
  ["1 root, trailing slash", "/evaluate/", "", KEEP],
  ["2 create", "/evaluate/create", "", KEEP],
  ["3 eval-server", "/evaluate/eval-server/srv", "", KEEP],
  ["4 suite", S, "", KEEP],
  ["4 suite ?view=runs", S, "?view=runs", KEEP],
  ["4 suite ?view=executions", S, "?view=executions", KEEP],
  ["4 suite ?view=cross-host", S, "?view=cross-host", KEEP],
  ["4 suite ?fromCommit=", S, "?fromCommit=abc", KEEP],
  [
    "5 suite ?view=test-cases",
    S,
    "?view=test-cases",
    to("suite-overview", casesTab, `${S}/settings/cases`),
  ],
  [
    "6 suite ?importJob=",
    S,
    "?importJob=job1",
    to("suite-overview", casesTab, `${S}/settings/cases?importJob=job1`),
  ],
  [
    "6 importJob any view, encoded",
    S,
    "?view=runs&importJob=a%2Fb%20c",
    to("suite-overview", casesTab, `${S}/settings/cases?importJob=a%2Fb%20c`),
  ],
  [
    "7 suite edit",
    `${S}/edit`,
    "",
    to(
      "suite-edit",
      { type: "suite-settings", suiteId: "S", tab: "settings" },
      `${S}/settings`,
    ),
  ],
  [
    "8 suite edit ?fromCaseChecks=",
    `${S}/edit`,
    "?fromCaseChecks=C",
    to(
      "suite-edit",
      { type: "suite-settings", suiteId: "S", tab: "evaluators" },
      `${S}/settings/evaluators`,
      { type: "case-evaluators", suiteId: "S", testCaseId: "C" },
    ),
  ],
  [
    "9 describe draft edit",
    `${S}/test/draft%3Adescribe/edit`,
    "",
    to(
      "test-edit",
      { type: "case-new", suiteId: "S" },
      `${S}/settings/cases/new`,
    ),
  ],
  [
    "9 describe draft edit, any query",
    `${S}/test/draft%3Adescribe/edit`,
    "?compare=1",
    to(
      "test-edit",
      { type: "case-new", suiteId: "S" },
      `${S}/settings/cases/new`,
    ),
  ],
  [
    "9 describe draft detail",
    `${S}/test/draft%3Adescribe`,
    "",
    to(
      "test-detail",
      { type: "case-new", suiteId: "S" },
      `${S}/settings/cases/new`,
    ),
  ],
  ["10 prompt draft edit", `${S}/test/draft%3Aprompt/edit`, "", KEEP],
  ["10 record draft edit", `${S}/test/draft%3Arecord/edit`, "", KEEP],
  ["10 prompt draft detail", `${S}/test/draft%3Aprompt`, "", KEEP],
  ["10 record draft detail", `${S}/test/draft%3Arecord`, "", KEEP],
  [
    "11 case edit",
    `${S}/test/C/edit`,
    "",
    to("test-edit", caseSettings("C"), `${S}/settings/cases/C`),
  ],
  [
    "11 encoded ids decode and re-encode",
    "/evaluate/suite/a%2Fb/test/c%20d/edit",
    "",
    to(
      "test-edit",
      { type: "case-settings", suiteId: "a/b", testCaseId: "c d" },
      "/evaluate/suite/a%2Fb/settings/cases/c%20d",
    ),
  ],
  ...["1", "true", "yes"].map(
    (value): [string, string, string, LegacyEvaluateMatch] => [
      `12 case edit ?checks=${value}`,
      `${S}/test/C/edit`,
      `?checks=${value}`,
      to(
        "test-edit",
        { type: "case-evaluators", suiteId: "S", testCaseId: "C" },
        `${S}/settings/cases/C/evaluators`,
      ),
    ],
  ),
  [
    "12 checks wins over compare and iteration",
    `${S}/test/C/edit`,
    "?compare=1&iteration=I&checks=1",
    to(
      "test-edit",
      { type: "case-evaluators", suiteId: "S", testCaseId: "C" },
      `${S}/settings/cases/C/evaluators`,
    ),
  ],
  [
    "13 case edit ?compare=1",
    `${S}/test/C/edit`,
    "?compare=1",
    to("test-edit", caseSettings("C"), `${S}/settings/cases/C`),
  ],
  [
    "14 case edit ?compare=1&iteration=",
    `${S}/test/C/edit`,
    "?compare=1&iteration=I",
    lookup("test-edit", "I", null, caseSettings("C")),
  ],
  [
    "14 case edit ?iteration=",
    `${S}/test/C/edit`,
    "?iteration=I",
    lookup("test-edit", "I", null, caseSettings("C")),
  ],
  [
    "15 case edit ?fromEvalServer=",
    `${S}/test/C/edit`,
    "?fromEvalServer=srv",
    KEEP,
  ],
  [
    "15 fromEvalServer wins over checks",
    `${S}/test/C/edit`,
    "?fromEvalServer=srv&checks=1",
    KEEP,
  ],
  [
    "9 draft wins over checks",
    `${S}/test/draft%3Adescribe/edit`,
    "?checks=1",
    to(
      "test-edit",
      { type: "case-new", suiteId: "S" },
      `${S}/settings/cases/new`,
    ),
  ],
  [
    "16 case detail",
    `${S}/test/C`,
    "",
    to("test-detail", caseSettings("C"), `${S}/settings/cases/C`),
  ],
  [
    "17 case detail ?iteration=",
    `${S}/test/C`,
    "?iteration=I",
    lookup("test-detail", "I", null, caseSettings("C")),
  ],
  ["18 suite run", `${S}/runs/R`, "", KEEP],
  ["18 suite run ?insights=1", `${S}/runs/R`, "?insights=1", KEEP],
  [
    "19 run ?case=",
    `${S}/runs/R`,
    "?case=C",
    to(
      "run-detail",
      { type: "test-run", suiteId: "S", runId: "R", testCaseId: "C" },
      `${S}/runs/R/cases/C`,
    ),
  ],
  [
    "20 run ?case=&iteration=",
    `${S}/runs/R`,
    "?case=C&iteration=I",
    to(
      "run-detail",
      {
        type: "iteration",
        suiteId: "S",
        runId: "R",
        testCaseId: "C",
        iterationId: "I",
      },
      `${S}/runs/R/cases/C/iter/I`,
    ),
  ],
  [
    "21 run ?iteration=",
    `${S}/runs/R`,
    "?iteration=I",
    lookup("run-detail", "I", "R", {
      type: "run-detail",
      suiteId: "S",
      runId: "R",
    }),
  ],
  [
    "22 run ?case=&compareTo=",
    `${S}/runs/R`,
    "?case=C&compareTo=X",
    to(
      "run-detail",
      { type: "test-run", suiteId: "S", runId: "R", testCaseId: "C" },
      `${S}/runs/R/cases/C`,
    ),
  ],
  [
    "22 run ?case=&insights=1",
    `${S}/runs/R`,
    "?case=C&insights=1",
    to(
      "run-detail",
      { type: "test-run", suiteId: "S", runId: "R", testCaseId: "C" },
      `${S}/runs/R/cases/C`,
    ),
  ],
  [
    "22 run ?case=&iteration=&compareTo=",
    `${S}/runs/R`,
    "?case=C&iteration=I&compareTo=X",
    to(
      "run-detail",
      {
        type: "iteration",
        suiteId: "S",
        runId: "R",
        testCaseId: "C",
        iterationId: "I",
      },
      `${S}/runs/R/cases/C/iter/I`,
    ),
  ],
  ["23 run ?compareTo=", `${S}/runs/R`, "?compareTo=X", KEEP],
  ["23 run /compare", `${S}/runs/R/compare`, "", KEEP],
  [
    "23 /compare wins over case",
    `${S}/runs/R/compare`,
    "?case=C&iteration=I",
    KEEP,
  ],
  ["24 runs tab", "/evaluate/runs", "", KEEP],
  ["24 settings", `${S}/settings`, "", KEEP],
  ["24 settings cases", `${S}/settings/cases`, "?importJob=J", KEEP],
  ["24 settings evaluators", `${S}/settings/evaluators`, "", KEEP],
  ["24 new case", `${S}/settings/cases/new`, "", KEEP],
  ["24 case settings", `${S}/settings/cases/C`, "", KEEP],
  ["24 case evaluators", `${S}/settings/cases/C/evaluators`, "", KEEP],
  ["25 test run", `${S}/runs/R/cases/C`, "", KEEP],
  ["25 test run ?target=", `${S}/runs/R/cases/C`, "?target=m", KEEP],
  ["25 test run edit", `${S}/runs/R/cases/C/edit`, "", KEEP],
  ["25 iteration", `${S}/runs/R/cases/C/iter/I`, "", KEEP],
  ["26 unknown leaf", "/evaluate/foo", "", UNMATCHED],
  ["26 case edit extra segment", `${S}/test/C/edit/x`, "", UNMATCHED],
  ["26 runs tab extra segment", "/evaluate/runs/x", "", UNMATCHED],
  ["26 unknown settings tab", `${S}/settings/foo`, "", UNMATCHED],
  ["26 run cases without a case", `${S}/runs/R/cases`, "", UNMATCHED],
  ["27 outside /evaluate", "/servers", "", KEEP],
  ["27 sibling prefix", "/evaluated", "", KEEP],
];

describe("matchLegacyEvaluatePath", () => {
  it.each(ROWS)("row %s", (_row, pathname, search, expected) => {
    expect(matchLegacyEvaluatePath(pathname, search)).toEqual(expected);
  });
});

describe("redirectForIteration", () => {
  const caseLookup: LegacyIterationLookup = {
    fromKind: "test-edit",
    suiteId: "S",
    iterationId: "I",
    runId: null,
    fallback: caseSettings("C"),
  };
  const runLookup: LegacyIterationLookup = {
    fromKind: "run-detail",
    suiteId: "S",
    iterationId: "I",
    runId: "R",
    fallback: { type: "run-detail", suiteId: "S", runId: "R" },
  };
  const iterationIn = (runId: string): EvalRoute => ({
    type: "iteration",
    suiteId: "S",
    runId,
    testCaseId: "C2",
    iterationId: "I",
  });

  it.each([
    [
      "case and run present",
      runLookup,
      { suiteRunId: "R", testCaseId: "C2" },
      iterationIn("R"),
      `${S}/runs/R/cases/C2/iter/I`,
    ],
    [
      "runId null takes the iteration's run",
      caseLookup,
      { suiteRunId: "R9", testCaseId: "C2" },
      iterationIn("R9"),
      `${S}/runs/R9/cases/C2/iter/I`,
    ],
    [
      "run differs from runId",
      runLookup,
      { suiteRunId: "R2", testCaseId: "C2" },
      runLookup.fallback,
      `${S}/runs/R`,
    ],
    [
      "no testCaseId",
      runLookup,
      { suiteRunId: "R", testCaseId: null },
      runLookup.fallback,
      `${S}/runs/R`,
    ],
    [
      "no suiteRunId (quick run)",
      caseLookup,
      { testCaseId: "C" },
      caseLookup.fallback,
      `${S}/settings/cases/C`,
    ],
    [
      "not found or unreadable",
      caseLookup,
      null,
      caseLookup.fallback,
      `${S}/settings/cases/C`,
    ],
  ] as const)("%s", (_name, input, iteration, expectedTo, expectedPath) => {
    expect(redirectForIteration(input, iteration)).toEqual({
      fromKind: input.fromKind,
      to: expectedTo,
      path: expectedPath,
    });
  });
});
