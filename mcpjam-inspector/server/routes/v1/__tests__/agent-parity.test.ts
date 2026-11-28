/**
 * Agent parity: every backend function the app calls is reachable by agents,
 * or recorded in `agent-parity/map.ts`. See that file for the rule and for
 * what a name-level check cannot see.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_OPERATIONS } from "@mcpjam/sdk/platform";
import { beforeAll, describe, expect, it } from "vitest";
import backlog from "./agent-parity/backlog.json";
import { checkParity, type ParityInputs } from "./agent-parity/check.js";
import {
  BACKLOG_MAX,
  COVERED,
  NOT_BACKEND_PREFIXES,
  NOT_EXPOSED,
} from "./agent-parity/map.js";
import {
  backendNamesIn,
  sourceFilesIn,
  sourceFilesUnder,
} from "./agent-parity/scan.js";

const V1_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSPECTOR_ROOT = join(V1_DIR, "..", "..", "..");
const PREFIXES = new Set(Object.keys(NOT_BACKEND_PREFIXES));

describe("agent parity", () => {
  let appCalls: Map<string, string[]>;
  let reachable: Set<string>;

  beforeAll(() => {
    appCalls = backendNamesIn(
      sourceFilesUnder(join(INSPECTOR_ROOT, "client", "src")),
      INSPECTOR_ROOT,
      PREFIXES,
    );
    reachable = new Set(
      backendNamesIn(sourceFilesIn(V1_DIR), INSPECTOR_ROOT, PREFIXES).keys(),
    );
  }, 60_000);

  it("scans the app and the v1 routes", () => {
    // A scan that silently found nothing would pass every check below.
    expect(appCalls.size).toBeGreaterThan(300);
    expect(reachable.size).toBeGreaterThan(150);
    expect(appCalls.has("serverQuality:requestServerQuality")).toBe(true);
    expect(reachable.has("serverQuality:cancelServerQuality")).toBe(true);
  });

  it("accounts for every backend function the app calls", () => {
    const problems = checkParity({
      appCalls,
      reachable,
      covered: COVERED,
      notExposed: NOT_EXPOSED,
      notBackendPrefixes: NOT_BACKEND_PREFIXES,
      backlog,
      backlogMax: BACKLOG_MAX,
      operationNames: new Set(ALL_OPERATIONS.map((op) => op.name)),
    });
    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("keeps the backlog sorted, so a diff shows exactly what changed", () => {
    expect(backlog).toEqual([...backlog].sort());
  });
});

describe("agent parity rules", () => {
  function inputs(overrides: Partial<ParityInputs> = {}): ParityInputs {
    return {
      appCalls: new Map([
        ["evals:run", ["client/src/run.tsx"]],
        ["evals:cancel", ["client/src/cancel.tsx"]],
      ]),
      reachable: new Set(["evals:run"]),
      covered: {},
      notExposed: {},
      notBackendPrefixes: { check: "eval step picker check ids" },
      backlog: ["evals:cancel"],
      backlogMax: 1,
      operationNames: new Set(["run_eval_suite"]),
      ...overrides,
    };
  }

  it("passes when every call is reachable or in the backlog", () => {
    expect(checkParity(inputs())).toEqual([]);
  });

  it("names an unaccounted call, its file, and both ways to fix it", () => {
    const [problem, ...rest] = checkParity(
      inputs({ backlog: [], backlogMax: 0 }),
    );
    expect(rest).toEqual([]);
    expect(problem).toContain("evals:cancel (client/src/cancel.tsx)");
    expect(problem).toContain("v1 route → SDK client method → operation");
    expect(problem).toMatch(/COVERED .* NOT_EXPOSED/);
  });

  it("accepts a covered call and a whole module marked not exposed", () => {
    expect(
      checkParity(
        inputs({
          backlog: [],
          backlogMax: 0,
          covered: { "evals:cancel": "run_eval_suite" },
        }),
      ),
    ).toEqual([]);
    expect(
      checkParity(
        inputs({
          backlog: [],
          backlogMax: 0,
          notExposed: { "evals:*": "Internal to the run page." },
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a covered entry naming an operation that does not exist", () => {
    expect(
      checkParity(
        inputs({
          backlog: [],
          backlogMax: 0,
          covered: { "evals:cancel": "cancel_everything" },
        }),
      ),
    ).toEqual([
      expect.stringContaining(
        "operation cancel_everything is not in ALL_OPERATIONS",
      ),
    ]);
  });

  it("refuses entries for calls the app no longer makes", () => {
    const problems = checkParity(
      inputs({
        covered: { "evals:gone": "run_eval_suite" },
        notExposed: { "billing:*": "Billing stays in the app." },
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("COVERED evals:gone: the app no longer calls it"),
      expect.stringContaining(
        "NOT_EXPOSED billing:*: the app no longer calls it",
      ),
    ]);
  });

  it("refuses a missing or overlong reason", () => {
    const problems = checkParity(
      inputs({
        backlog: [],
        backlogMax: 0,
        notExposed: { "evals:cancel": "x".repeat(161) },
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("one-line reason of at most 160 characters"),
    ]);
  });

  it("refuses a prefix exemption that does not say what it exempts", () => {
    expect(
      checkParity(inputs({ notBackendPrefixes: { billing: " " } })),
    ).toEqual([expect.stringContaining("NOT_BACKEND_PREFIXES billing")]);
  });

  it("drops a backlog entry once agents can reach it", () => {
    const problems = checkParity(
      inputs({ reachable: new Set(["evals:run", "evals:cancel"]) }),
    );
    expect(problems).toEqual([
      expect.stringContaining("Backlog evals:cancel: a v1 route now names it"),
    ]);
  });

  it("drops a backlog entry the app no longer calls", () => {
    const problems = checkParity(
      inputs({ appCalls: new Map([["evals:run", ["client/src/run.tsx"]]]) }),
    );
    expect(problems).toEqual([
      expect.stringContaining(
        "Backlog evals:cancel: the app no longer calls it",
      ),
    ]);
  });

  it("refuses a backlog that grows past BACKLOG_MAX", () => {
    const problems = checkParity(
      inputs({
        appCalls: new Map([
          ["evals:run", ["a.tsx"]],
          ["evals:cancel", ["b.tsx"]],
          ["evals:pause", ["c.tsx"]],
        ]),
        backlog: ["evals:cancel", "evals:pause"],
      }),
    );
    expect(problems).toEqual([
      expect.stringContaining("grew to 2 entries (BACKLOG_MAX is 1)"),
    ]);
  });

  it("asks for BACKLOG_MAX to come down when the backlog shrinks", () => {
    // Exact, not a ceiling: slack left by a resolved entry would let a new
    // one in without anyone editing the constant.
    expect(checkParity(inputs({ backlogMax: 2 }))).toEqual([
      expect.stringContaining("lower BACKLOG_MAX"),
    ]);
  });

  it("refuses a duplicate backlog entry", () => {
    const problems = checkParity(
      inputs({ backlog: ["evals:cancel", "evals:cancel"], backlogMax: 2 }),
    );
    expect(problems).toEqual([
      expect.stringContaining("lists a function twice"),
    ]);
  });
});
