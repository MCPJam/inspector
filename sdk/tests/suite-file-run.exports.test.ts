/**
 * Where the local runner is — and is not — exported.
 *
 * `runSuiteFile` connects servers, spawns processes and runs models, so it is
 * a Node entry-point export only. The browser and contract entries must never
 * pull it in: they ship to places that cannot run it, and a pure contract
 * that re-exported runtime wiring would drag that wiring into every consumer.
 * The pure pieces a renderer needs (the local report narrowing) are reached
 * through the structured-report renderers, not the contract.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser";
import * as contract from "../src/contract/index";
import * as runner from "../src/suite-file-run/index";

const here = dirname(fileURLToPath(import.meta.url));

describe("suite-file runner exports", () => {
  it("the facade exposes the public runner, its error and the report helpers", () => {
    for (const name of [
      "runSuiteFile",
      "createSuiteFileRunner",
      "isSuiteFileRunError",
      "formatLocalEvalRunSummary",
      "isLocalEvalRunReport",
      "platformCaseFromSuiteFileCase",
      "suiteFileSourceHash",
    ] as const) {
      expect(typeof runner[name], name).toBe("function");
    }
    expect(typeof runner.SuiteFileRunError).toBe("function");
    expect(runner.LOCAL_EVAL_RUN_REPORT_KIND).toBe("eval-local-run");
    expect(runner.LOCAL_VERDICT_AUTHORITY).toBe("local-policy-v2");
    expect(runner.SUITE_FILE_RUN_DEFAULT_CONCURRENCY).toBe(1);
    expect(runner.SUITE_FILE_RUN_DEFAULT_ITERATION_TIMEOUT_MS).toBe(120_000);
    expect(runner.SUITE_FILE_RUN_DEFAULT_MAX_STEPS).toBe(10);
    expect(runner.SUITE_FILE_RUN_DEFAULT_SETUP_TIMEOUT_MS).toBe(30_000);
  });

  it("the root entry re-exports the facade", () => {
    const index = readFileSync(join(here, "../src/index.ts"), "utf8");
    for (const name of ["runSuiteFile", "createSuiteFileRunner", "SuiteFileRunError", "formatLocalEvalRunSummary"]) {
      expect(index).toContain(`  ${name},`);
    }
    expect(index).toContain('} from "./suite-file-run/index.js";');
  });

  it("stays out of the browser and contract entries", () => {
    for (const name of ["runSuiteFile", "createSuiteFileRunner", "SuiteFileRunError"]) {
      expect(name in browser, `browser exports ${name}`).toBe(false);
      expect(name in contract, `contract exports ${name}`).toBe(false);
    }
  });
});
