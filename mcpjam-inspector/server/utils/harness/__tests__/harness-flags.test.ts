import { afterEach, expect, it, vi } from "vitest";
import { harnessQuietClaudeStartup, hostedWarmAgentEnabled } from "../harness-flags.js";

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

it.each([undefined, "", "1", "TRUE", "false"])("keeps Claude Code's start-up traffic unless switched on (%s)", (value) => {
  vi.stubEnv("MCPJAM_HARNESS_QUIET_CLAUDE_STARTUP", value);
  expect(harnessQuietClaudeStartup()).toBe(false);
});

it("quiets Claude Code's start-up only when the switch reads exactly true", () => {
  vi.stubEnv("MCPJAM_HARNESS_QUIET_CLAUDE_STARTUP", "true");
  expect(harnessQuietClaudeStartup()).toBe(true);
});
