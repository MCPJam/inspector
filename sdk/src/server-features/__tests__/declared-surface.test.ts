import { describe, expect, it } from "vitest";
import { toDeclaredSurface } from "../declared-surface.js";

describe("toDeclaredSurface", () => {
  it("restores fidelity strings to their MCP field names", () => {
    const surface = toDeclaredSurface({
      envelopeVersion: 3,
      snapshot: {
        serverId: "srv",
        tools: [
          {
            name: "draw",
            meta: { ui: {} },
            metaJson: JSON.stringify({ ui: { resourceUri: "ui://draw" }, _x: 1 }),
            inputSchema: { type: "object" },
            inputSchemaJson: JSON.stringify({ $schema: "s", type: "object" }),
          },
        ],
        discovery: {
          protocolVersion: "2026-07-28",
          capabilities: { tools: {} },
          capabilitiesJson: JSON.stringify({ tools: {}, extensions: { "x/y": {} } }),
        },
        coverage: { tools: "complete", toolMeta: "complete", capabilities: "complete" },
        transport: "streamable-http",
      },
    });
    expect(surface?.tools[0]._meta).toEqual({ ui: { resourceUri: "ui://draw" }, _x: 1 });
    expect(surface?.tools[0].inputSchema).toEqual({ $schema: "s", type: "object" });
    expect(surface?.tools[0]).not.toHaveProperty("metaJson");
    expect(surface?.capabilities).toEqual({ tools: {}, extensions: { "x/y": {} } });
    expect(surface?.protocolVersion).toBe("2026-07-28");
    expect(surface?.coverage.tools).toBe("complete");
    expect(surface?.coverage.prompts).toBe("not-captured");
  });

  it("falls back to the stripped object when a fidelity string is malformed", () => {
    const surface = toDeclaredSurface({
      envelopeVersion: 3,
      snapshot: { serverId: "srv", tools: [{ name: "a", meta: { k: 1 }, metaJson: "{" }] },
    });
    expect(surface?.tools[0]._meta).toEqual({ k: 1 });
  });

  it("weakens coverage for every field the storage budget dropped", () => {
    const surface = toDeclaredSurface({
      envelopeVersion: 3,
      snapshot: {
        serverId: "srv",
        tools: [],
        coverage: {
          tools: "complete",
          toolMeta: "complete",
          capabilities: "complete",
          resources: "complete",
        },
      },
      redaction: {
        droppedFields: ["tools[2].metaJson", "discovery.capabilities", "resources"],
      },
    });
    expect(surface?.coverage.toolMeta).toBe("partial");
    expect(surface?.coverage.capabilities).toBe("partial");
    expect(surface?.coverage.resources).toBe("partial");
    expect(surface?.coverage.tools).toBe("complete");
  });

  it("claims nothing complete about a legacy snapshot except the tool list", () => {
    const surface = toDeclaredSurface({
      envelopeVersion: 2,
      snapshot: {
        serverId: "srv",
        tools: [{ name: "a", metadata: { k: 1 } }],
        discovery: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
      },
    });
    expect(surface?.coverage.tools).toBe("complete");
    expect(surface?.coverage.toolMeta).toBe("partial");
    expect(surface?.coverage.capabilities).toBe("partial");
    expect(surface?.coverage.resources).toBe("not-captured");
    expect(surface?.tools[0]._meta).toEqual({ k: 1 });
  });

  it("marks everything at most partial when the capture reported an error", () => {
    const surface = toDeclaredSurface({
      envelopeVersion: 3,
      snapshot: {
        serverId: "srv",
        tools: [],
        captureError: "timeout",
        coverage: { tools: "complete" },
      },
    });
    expect(surface?.coverage.tools).toBe("partial");
  });

  it("returns undefined for something that is not a snapshot", () => {
    expect(toDeclaredSurface({ snapshot: null })).toBeUndefined();
  });
});
