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
