import { describe, expect, it } from "vitest";

import {
  HARNESS_MCP_AT_TURN_LIMITS,
  parseHarnessMcpAtTurn,
} from "../src/host-config/internal.js";

const DIGEST = "f".repeat(64);

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    upstream: "mcpjam",
    delivery: "host-tools",
    gaps: [],
    reasons: [],
    pinnedRuntimeVersion: "2.1.245",
    plannerVersion: "harness-mcp-plan-v1",
    ...overrides,
  };
}

describe("parseHarnessMcpAtTurn", () => {
  it.each([
    ["host tools", { profile: "client", profileDigest: DIGEST }],
    ["the rebuild proxy", { delivery: "mcp-endpoint", profile: "client" }],
    [
      "pass-through forwarding",
      {
        upstream: "harness",
        delivery: "mcp-endpoint",
        forwarding: { kind: "pass-through" },
      },
    ],
    [
      "profiled forwarding",
      {
        delivery: "mcp-endpoint",
        profile: "client",
        forwarding: { kind: "profiled" },
        gaps: ["app-host-capabilities"],
      },
    ],
  ])("keeps a receipt for %s exactly as written", (_route, fields) => {
    const value = receipt(fields);
    expect(parseHarnessMcpAtTurn(value)).toEqual(value);
  });

  it.each([
    ["a later version", { version: 2 }],
    [
      "a profile on the harness's own client",
      {
        upstream: "harness",
        delivery: "mcp-endpoint",
        forwarding: { kind: "pass-through" },
        profile: "client",
      },
    ],
    [
      "the harness client without forwarding",
      { upstream: "harness", delivery: "mcp-endpoint" },
    ],
    [
      "pass-through on MCPJam's client",
      { delivery: "mcp-endpoint", forwarding: { kind: "pass-through" } },
    ],
    ["profiled forwarding on host tools", { forwarding: { kind: "profiled" } }],
    [
      "profiled forwarding with the generic profile",
      {
        delivery: "mcp-endpoint",
        profile: "generic",
        forwarding: { kind: "profiled" },
      },
    ],
    ["a digest without the client profile", { profileDigest: DIGEST }],
    ["a null optional field", { adapterVersion: null }],
  ])("drops a receipt with %s", (_case, fields) => {
    expect(parseHarnessMcpAtTurn(receipt(fields))).toBeUndefined();
  });

  it("holds the documented limits and drops the whole receipt past them", () => {
    const { string, evidence, gaps, reasons } = HARNESS_MCP_AT_TURN_LIMITS;
    const atCaps = receipt({
      gaps: Array.from({ length: gaps }, () => "g".repeat(string)),
      reasons: Array.from({ length: reasons }, () => "r".repeat(string)),
      qualification: { status: "unsupported", evidence: "e".repeat(evidence) },
    });
    expect(parseHarnessMcpAtTurn(atCaps)).toEqual(atCaps);
    for (const over of [
      { gaps: Array.from({ length: gaps + 1 }, () => "g") },
      { reasons: Array.from({ length: reasons + 1 }, () => "r") },
      { reasons: ["r".repeat(string + 1)] },
      { pinnedRuntimeVersion: "p".repeat(string + 1) },
      {
        qualification: {
          status: "supported",
          evidence: "e".repeat(evidence + 1),
        },
      },
      { profile: "client", profileDigest: "f".repeat(63) },
    ]) {
      expect(parseHarnessMcpAtTurn(receipt(over))).toBeUndefined();
    }
  });

  it("copies known keys only, so a stray secret never reaches storage", () => {
    const parsed = parseHarnessMcpAtTurn({
      ...receipt({ qualification: { status: "supported", token: "t" } }),
      apiKey: "sk-live",
    });
    expect(parsed).toEqual(receipt({ qualification: { status: "supported" } }));
    expect(JSON.stringify(parsed)).not.toMatch(/sk-live|"t"/);
  });

  it.each([null, undefined, "receipt", [], {}])("drops %j", (value) => {
    expect(parseHarnessMcpAtTurn(value)).toBeUndefined();
  });
});
