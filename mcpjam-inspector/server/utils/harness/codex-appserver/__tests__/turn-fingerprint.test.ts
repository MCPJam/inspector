/**
 * The fingerprint decides whether a live Codex thread is reused or rebuilt.
 *
 * Codex reads its MCP server's tool list ONCE, at startup, and this adapter
 * wires no `tools/list_changed`. So a change the fingerprint misses is not a
 * cosmetic staleness: the model keeps calling a tool by an old contract for the
 * rest of the session.
 */
import { describe, expect, it } from "vitest";
import { turnConfigurationFingerprintInput } from "../shared/turn-fingerprint.js";

const tool = (over: Record<string, unknown> = {}) => ({
  name: "mcp__weather__get_forecast",
  description: "Forecast for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
  },
  ...over,
});

describe("turnConfigurationFingerprintInput", () => {
  it("is stable across turns with identical configuration", () => {
    const a = turnConfigurationFingerprintInput({
      instructions: "be brief",
      tools: [tool()],
    });
    const b = turnConfigurationFingerprintInput({
      instructions: "be brief",
      tools: [tool()],
    });
    expect(a).toBe(b);
  });

  it("changes when a tool's SCHEMA changes under a fixed name", () => {
    // The case names alone missed. Same tool name, new required argument.
    const before = turnConfigurationFingerprintInput({
      instructions: undefined,
      tools: [tool()],
    });
    const after = turnConfigurationFingerprintInput({
      instructions: undefined,
      tools: [
        tool({
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" }, unit: { type: "string" } },
            required: ["unit"],
          },
        }),
      ],
    });
    expect(after).not.toBe(before);
  });

  it("changes when a tool's DESCRIPTION changes under a fixed name", () => {
    const before = turnConfigurationFingerprintInput({
      instructions: undefined,
      tools: [tool()],
    });
    const after = turnConfigurationFingerprintInput({
      instructions: undefined,
      tools: [tool({ description: "Forecast, now in Kelvin" })],
    });
    expect(after).not.toBe(before);
  });

  it("ignores tool ORDER, which carries no meaning", () => {
    const one = tool();
    const two = tool({ name: "mcp__weather__get_history" });
    expect(
      turnConfigurationFingerprintInput({
        instructions: undefined,
        tools: [one, two],
      }),
    ).toBe(
      turnConfigurationFingerprintInput({
        instructions: undefined,
        tools: [two, one],
      }),
    );
  });

  it("ignores KEY order inside a schema", () => {
    // Load-bearing: an upstream object built in a different key order would
    // otherwise look like a changed tool and restart the thread every turn,
    // which breaks multi-turn resume outright — worse than the staleness this
    // fingerprint exists to catch.
    const a = turnConfigurationFingerprintInput({
      instructions: undefined,
      tools: [
        tool({ inputSchema: { type: "object", properties: { a: 1, b: 2 } } }),
      ],
    });
    const b = turnConfigurationFingerprintInput({
      instructions: undefined,
      tools: [
        tool({ inputSchema: { properties: { b: 2, a: 1 }, type: "object" } }),
      ],
    });
    expect(a).toBe(b);
  });

  it("distinguishes an absent description from an empty one, and handles no tools", () => {
    expect(
      turnConfigurationFingerprintInput({
        instructions: undefined,
        tools: [],
      }),
    ).toBe(
      turnConfigurationFingerprintInput({ instructions: "", tools: [] }),
    );
    // A tool with no schema at all is representable and must not throw.
    expect(() =>
      turnConfigurationFingerprintInput({
        instructions: undefined,
        tools: [{ name: "bare" }],
      }),
    ).not.toThrow();
  });
});
