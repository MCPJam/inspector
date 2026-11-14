import { afterEach, expect, it, vi } from "vitest";
import {
  harnessApiWarmEnabled,
  harnessPrepareBoxEnabled,
  harnessPrepareBoxSwitchedOn,
  hostedWarmAgentEnabled,
} from "../harness-flags.js";

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "", "1", "true"])("enables authorized organizations by default (%s)", (value) => {
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT", value);
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT_ORG_IDS", undefined);
  expect(hostedWarmAgentEnabled("organization-a")).toBe(true);
  expect(hostedWarmAgentEnabled("organization-b")).toBe(true);
  expect(hostedWarmAgentEnabled(undefined)).toBe(false);
  expect(hostedWarmAgentEnabled("")).toBe(false);
});

it.each(["0", "false", " FALSE "])("honors the global disable switch (%s)", (value) => {
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT", value);
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT_ORG_IDS", "organization-a");
  expect(hostedWarmAgentEnabled("organization-a")).toBe(false);
});

it("preserves an explicit organization restriction", () => {
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT", undefined);
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT_ORG_IDS", " organization-a, ,organization-b ");
  expect(hostedWarmAgentEnabled("organization-a")).toBe(true);
  expect(hostedWarmAgentEnabled("organization-b")).toBe(true);
  expect(hostedWarmAgentEnabled("organization-c")).toBe(false);
});

it("treats an empty restriction as unrestricted", () => {
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT", undefined);
  vi.stubEnv("MCPJAM_HOSTED_WARM_AGENT_ORG_IDS", " , ");
  expect(hostedWarmAgentEnabled("organization-a")).toBe(true);
});

it.each([undefined, "", "0", "false", "yes"])("keeps box preparation off unless switched on (%s)", (value) => {
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX", value);
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX_ORG_IDS", undefined);
  expect(harnessPrepareBoxSwitchedOn()).toBe(false);
  expect(harnessPrepareBoxEnabled("organization-a")).toBe(false);
});

it.each(["1", "true", " TRUE "])("prepares boxes for every organization once on (%s)", (value) => {
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX", value);
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX_ORG_IDS", undefined);
  expect(harnessPrepareBoxSwitchedOn()).toBe(true);
  expect(harnessPrepareBoxEnabled("organization-a")).toBe(true);
  expect(harnessPrepareBoxEnabled(undefined)).toBe(false);
});

it("limits box preparation to the listed organizations", () => {
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX", "true");
  vi.stubEnv("MCPJAM_HARNESS_PREPARE_BOX_ORG_IDS", " organization-a, ,organization-b ");
  expect(harnessPrepareBoxEnabled("organization-a")).toBe(true);
  expect(harnessPrepareBoxEnabled("organization-c")).toBe(false);
});

it.each([undefined, "", "1", "TRUE", "false"])("keeps API warm reuse off unless set to true (%s)", (value) => {
  vi.stubEnv("MCPJAM_HARNESS_API_WARM", value);
  expect(harnessApiWarmEnabled()).toBe(false);
});

it("turns API warm reuse on when set to true", () => {
  vi.stubEnv("MCPJAM_HARNESS_API_WARM", "true");
  expect(harnessApiWarmEnabled()).toBe(true);
});
