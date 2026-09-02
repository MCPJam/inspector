/**
 * The fingerprint decides whether a live Codex thread is reused or rebuilt.
 *
 * Codex reads its MCP server's tool list ONCE, at startup, and this adapter
 * wires no `tools/list_changed`. So a change the fingerprint misses is not a
 * cosmetic staleness: the model keeps calling a tool by an old contract for the
 * rest of the session.
 */
import { describe, expect, it } from "vitest";
import {
  runtimeConfigFingerprint,
  turnConfigurationFingerprintInput,
} from "../shared/turn-fingerprint.js";

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
    ).toBe(turnConfigurationFingerprintInput({ instructions: "", tools: [] }));
    // A tool with no schema at all is representable and must not throw.
    expect(() =>
      turnConfigurationFingerprintInput({
        instructions: undefined,
        tools: [{ name: "bare" }],
      }),
    ).not.toThrow();
  });
});

/*
 * The COARSER fingerprint, and the one that has to be right for a changed
 * server selection to take effect at all.
 *
 * A restarted thread is not enough here. `thread/start` does not re-read the
 * MCP server's tools — the PROCESS does, once, at spawn — so if this string
 * fails to move, `ensureRuntime` reuses a Codex that booted with the old
 * catalog and the newly selected server is simply uncallable, with no error
 * anywhere to say so.
 */
describe("runtimeConfigFingerprint", () => {
  it("moves when the tool SET changes between turns", () => {
    const turnOne = runtimeConfigFingerprint({ tools: [tool()] });
    const turnTwo = runtimeConfigFingerprint({
      tools: [tool(), tool({ name: "mcp__docs__search" })],
    });
    expect(turnOne).not.toBe(turnTwo);
    // ...and removing one moves it back, so a de-selected server rebuilds too.
    expect(runtimeConfigFingerprint({ tools: [tool()] })).toBe(turnOne);
  });

  it("moves when a tool keeps its NAME but changes its contract", () => {
    // The case a name-keyed fingerprint missed: same server, same tool, edited
    // schema. The process must be rebuilt, not just the thread.
    const before = runtimeConfigFingerprint({ tools: [tool()] });
    const afterSchema = runtimeConfigFingerprint({
      tools: [
        tool({
          inputSchema: {
            type: "object",
            properties: { zip: { type: "string" } },
          },
        }),
      ],
    });
    const afterDescription = runtimeConfigFingerprint({
      tools: [tool({ description: "Forecast, now with humidity" })],
    });
    expect(afterSchema).not.toBe(before);
    expect(afterDescription).not.toBe(before);
  });

  it("moves when web search is toggled", () => {
    // Rendered into the `config.toml` the process reads at startup, so it is a
    // runtime property rather than a thread one.
    expect(runtimeConfigFingerprint({ webSearch: true, tools: [] })).not.toBe(
      runtimeConfigFingerprint({ webSearch: false, tools: [] }),
    );
    // Absent means off, so an unset flag must not force a rebuild.
    expect(runtimeConfigFingerprint({ tools: [] })).toBe(
      runtimeConfigFingerprint({ webSearch: false, tools: [] }),
    );
  });

  it("holds still across turns that changed nothing", () => {
    // The other half of the contract: a spurious rebuild kills the parked
    // thread and loses the conversation inside Codex.
    const start = { webSearch: true, tools: [tool(), tool({ name: "a__b" })] };
    expect(runtimeConfigFingerprint(start)).toBe(
      runtimeConfigFingerprint({
        webSearch: true,
        // Same set, different order and different key order within a schema.
        tools: [tool({ name: "a__b" }), tool()],
      }),
    );
  });

  it("is unaffected by instructions, which a thread restart CAN absorb", () => {
    // Deliberate asymmetry: `instructions` is a `thread/start` parameter, so
    // rebuilding the process for it would throw away a live thread for nothing.
    expect(
      turnConfigurationFingerprintInput({
        instructions: "be brief",
        tools: [tool()],
      }),
    ).not.toBe(
      turnConfigurationFingerprintInput({
        instructions: "be thorough",
        tools: [tool()],
      }),
    );
    expect(runtimeConfigFingerprint({ tools: [tool()] })).toBe(
      runtimeConfigFingerprint({ tools: [tool()] }),
    );
  });
});
