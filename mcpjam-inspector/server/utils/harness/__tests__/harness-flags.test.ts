import { afterEach, expect, it, vi } from "vitest";
import {
  harnessApiWarmEnabled,
  harnessKeepAgentThroughPause,
} from "../harness-flags.js";

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "", "1", "TRUE", "false"])(
  "keeps no agent through its box's pause unless switched on (%s)",
  (value) => {
    vi.stubEnv("MCPJAM_HARNESS_KEEP_THROUGH_PAUSE", value);
    expect(harnessKeepAgentThroughPause()).toBe(false);
  },
);

it("keeps an agent through its box's pause when switched on, read per call", () => {
  vi.stubEnv("MCPJAM_HARNESS_KEEP_THROUGH_PAUSE", "true");
  expect(harnessKeepAgentThroughPause()).toBe(true);
  vi.stubEnv("MCPJAM_HARNESS_KEEP_THROUGH_PAUSE", "false");
  expect(harnessKeepAgentThroughPause()).toBe(false);
});

it.each([undefined, "", "1", "TRUE", "false"])("keeps API warm reuse off unless set to true (%s)", (value) => {
  vi.stubEnv("MCPJAM_HARNESS_API_WARM", value);
  expect(harnessApiWarmEnabled()).toBe(false);
});

it("turns API warm reuse on when set to true", () => {
  vi.stubEnv("MCPJAM_HARNESS_API_WARM", "true");
  expect(harnessApiWarmEnabled()).toBe(true);
});
