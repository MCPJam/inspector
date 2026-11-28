import { describe, expect, it } from "vitest";

import {
  caseConcurrencyForRun,
  EVAL_RUN_SANDBOX_SLOTS,
} from "../run-sandbox-slots";

describe("caseConcurrencyForRun (PLB-579)", () => {
  const BROWSER = {
    builtInToolIds: ["browser"],
    browserToolPolicy: { mode: "allow_all" },
  };

  it("does not limit a run that boots no box", () => {
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: {},
        environment: { servers: [] },
        runId: "run-1",
      }),
    ).toBeUndefined();
  });

  it("limits a Browser run to the backend's per-run budget", () => {
    expect(EVAL_RUN_SANDBOX_SLOTS).toBe(4);
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: BROWSER,
        environment: { servers: [] },
        runId: "run-1",
      }),
    ).toBe(4);
  });

  it("limits a harness run and a pinned-image run the same way", () => {
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: { harness: "claude-code" },
        environment: { servers: [] },
        runId: "run-1",
      }),
    ).toBe(4);
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: {},
        environment: { servers: [], computerEnvironmentId: "env-1" },
        runId: "run-1",
      }),
    ).toBe(4);
  });

  it("halves the limit when a pinned image is paired with a desktop", () => {
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: BROWSER,
        environment: { servers: [], computerEnvironmentId: "env-1" },
        runId: "run-1",
      }),
    ).toBe(2);
  });

  it("does not limit a single-case run, which has no per-run budget", () => {
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: { harness: "claude-code" },
        environment: { servers: [] },
        runId: null,
      }),
    ).toBeUndefined();
  });

  it("counts a browser without a policy as no box, like the runner", () => {
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: { builtInToolIds: ["browser"] },
        environment: { servers: [] },
        runId: "run-1",
      }),
    ).toBeUndefined();
  });

  it("ignores a malformed builtInToolIds instead of throwing", () => {
    expect(
      caseConcurrencyForRun({
        suiteHostConfig: { builtInToolIds: "browser" },
        environment: undefined,
        runId: "run-1",
      }),
    ).toBeUndefined();
  });
});
