import { vi } from "vitest";

Object.assign(globalThis, {
  jest: Object.assign(vi, {
    requireActual: vi.importActual.bind(vi),
  }),
});

// Unit tests do not discover the checkout running the test; git discovery has dedicated temporary-repository tests.
process.env.MCPJAM_GIT_AUTODETECT = "false";

// Every EvalTest.run() here would otherwise post `eval_test_run_triggered` to production PostHog, where it is counted as customer usage. Telemetry tests clear this themselves.
process.env.DO_NOT_TRACK = "1";

// Execution unit tests isolate model and evaluator behavior from online accounting.
// Identity integration tests unmock this boundary and exercise real transport.
vi.mock("../src/eval-run-start.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/eval-run-start.js")>();
  return { ...actual, startEvalRun: vi.fn(async () => ({
    ok: true, runStartId: "503af9f5-1ef4-4424-9629-a61c9ee54e48",
    organizationId: "test-org", projectId: "test-project",
  })) };
});
