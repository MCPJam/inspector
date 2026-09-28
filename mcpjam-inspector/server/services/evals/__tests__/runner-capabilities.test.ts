/**
 * What this process tells the backend it can do.
 *
 * Both entries are PROMISES the backend acts on, and the cost of a false one
 * is the same in each case: the backend stops protecting the run from a
 * delivery this runner does not actually have.
 *
 *   - `harness-execution` pins the run's `harness` selector, so a runner that
 *     claims it and then emulates gets a run stamped with an engine it never
 *     ran.
 *   - `browser-materialized-secrets` lifts four refusals that exist because an
 *     eval or journey box receives no materialized secret. A runner that
 *     claims it with the feature switched off launches a run whose every
 *     `{{secret:NAME}}` is refused as unknown — the credential silently
 *     absent, which is exactly what those refusals prevent.
 */
import { describe, expect, it } from "vitest";
import { runnerCapabilities } from "../runner-capabilities";

describe("runnerCapabilities", () => {
  it("declares harness execution, always", () => {
    expect(runnerCapabilities({} as NodeJS.ProcessEnv)).toEqual([
      "harness-execution",
    ]);
  });

  it("does NOT claim browser secrets while the feature is off", () => {
    // Off, `resolveBrowserSecrets` returns nothing and every placeholder is
    // refused — so claiming the capability would be claiming a delivery this
    // process demonstrably does not have.
    for (const env of [{}, { MCPJAM_BROWSER_SECRET_PLACEHOLDERS: "0" }]) {
      expect(
        runnerCapabilities(env as NodeJS.ProcessEnv),
        JSON.stringify(env),
      ).not.toContain("browser-materialized-secrets");
    }
  });

  it("claims it once the feature is on", () => {
    expect(
      runnerCapabilities({
        MCPJAM_BROWSER_SECRET_PLACEHOLDERS: "1",
      } as NodeJS.ProcessEnv),
    ).toEqual(["harness-execution", "browser-materialized-secrets"]);
  });

  it("reads the flag at CALL time, not at import time", () => {
    // A module constant would freeze whatever the environment said when this
    // module first loaded — wrong for a switch flipped per-process in staging
    // and per-test.
    const before = process.env.MCPJAM_BROWSER_SECRET_PLACEHOLDERS;
    try {
      process.env.MCPJAM_BROWSER_SECRET_PLACEHOLDERS = "1";
      expect(runnerCapabilities()).toContain("browser-materialized-secrets");
      delete process.env.MCPJAM_BROWSER_SECRET_PLACEHOLDERS;
      expect(runnerCapabilities()).not.toContain(
        "browser-materialized-secrets",
      );
    } finally {
      if (before === undefined)
        delete process.env.MCPJAM_BROWSER_SECRET_PLACEHOLDERS;
      else process.env.MCPJAM_BROWSER_SECRET_PLACEHOLDERS = before;
    }
  });

  it("spells the string the backend gates on", () => {
    // The backend is a different repository and cannot import this. Its own
    // `RUNNER_CAPABILITY_BROWSER_MATERIALIZED_SECRETS` pins the same literal
    // from the other side; a drift on either makes the gate silently refuse.
    expect(
      runnerCapabilities({
        MCPJAM_BROWSER_SECRET_PLACEHOLDERS: "1",
      } as NodeJS.ProcessEnv),
    ).toContain("browser-materialized-secrets");
  });
});
