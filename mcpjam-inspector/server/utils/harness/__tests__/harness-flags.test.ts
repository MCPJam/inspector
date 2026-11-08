import { afterEach, expect, it, vi } from "vitest";
import {
  harnessNativeImagesEnabled,
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

it.each([undefined, "", "true", "1"])(
  "enables native harness images by default (%s)",
  (value) => {
    vi.stubEnv("MCPJAM_HARNESS_NATIVE_IMAGES", value);
    expect(harnessNativeImagesEnabled()).toBe(true);
  },
);

it("disables native harness images only on false", () => {
  vi.stubEnv("MCPJAM_HARNESS_NATIVE_IMAGES", "false");
  expect(harnessNativeImagesEnabled()).toBe(false);
});
