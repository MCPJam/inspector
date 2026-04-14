import {
  normalizeServerSnapshot,
  serializeServerSnapshot,
  serializeStableServerSnapshot,
  type CollectedServerSnapshot,
  ServerSnapshotFormatError,
} from "../src/server-snapshot";

function makeCollectedSnapshot(): CollectedServerSnapshot<string> {
  return {
    target: "https://example.com/mcp",
    generatedAt: "2026-04-13T00:00:00.000Z",
    initInfo: {
      serverInfo: { version: "1.0.0", name: "Example" },
      protocolVersion: "2025-11-25",
    },
    capabilities: {
      prompts: {},
      tools: {},
    },
    tools: [
      {
        name: "zeta",
        description: "Second tool",
        inputSchema: {
          enum: ["beta", "alpha"],
          properties: {
            b: { type: "string" },
            a: { type: "string" },
          },
          required: ["b", "a"],
          type: "object",
        },
      },
      {
        name: "alpha",
        description: "First tool",
      },
    ],
    toolsMetadata: {
      zeta: { z: true, a: true },
    },
    resources: [
      {
        uri: "file:///z.txt",
        name: "Zed",
      },
      {
        uri: "file:///a.txt",
        name: "Alpha",
      },
    ],
    resourceTemplates: [
      {
        uriTemplate: "note://{id}",
        name: "Note",
      },
    ],
    resourceTemplatesSupported: true,
    prompts: [
      {
        name: "summarize",
        description: "Summarize text",
      },
      {
        name: "annotate",
        description: "Annotate text",
        arguments: [
          { name: "zeta", required: false, description: "Second" },
          { name: "alpha", required: true, description: "First" },
        ],
      },
    ],
  };
}

describe("serializeServerSnapshot", () => {
  it("preserves the raw export contract by default", () => {
    const snapshot = makeCollectedSnapshot();

    const result = serializeServerSnapshot(snapshot);

    expect(result).toEqual({
      target: "https://example.com/mcp",
      exportedAt: "2026-04-13T00:00:00.000Z",
      initInfo: snapshot.initInfo,
      capabilities: snapshot.capabilities,
      tools: snapshot.tools,
      toolsMetadata: snapshot.toolsMetadata,
      resources: snapshot.resources,
      resourceTemplates: snapshot.resourceTemplates,
      prompts: snapshot.prompts,
    });
  });

  it("emits a versioned stable snapshot for baseline mode", () => {
    const snapshot = makeCollectedSnapshot();

    const result = serializeStableServerSnapshot(snapshot);

    expect(result.kind).toBe("server-snapshot");
    expect(result.schemaVersion).toBe(1);
    expect(result).not.toHaveProperty("exportedAt");
    expect(result.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(result.resources.map((resource) => resource.uri)).toEqual([
      "file:///a.txt",
      "file:///z.txt",
    ]);
    expect(result.prompts.map((prompt) => prompt.name)).toEqual([
      "annotate",
      "summarize",
    ]);
    expect(result.toolsMetadata).toEqual({
      zeta: { a: true, z: true },
    });
    expect(result.resourceTemplatesSupported).toBe(true);
    expect(result.tools[1]?.inputSchema).toEqual({
      enum: ["alpha", "beta"],
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a", "b"],
      type: "object",
    });
    expect(result.prompts[0]?.arguments).toEqual([
      { description: "First", name: "alpha", required: true },
      { description: "Second", name: "zeta", required: false },
    ]);
  });
});

describe("normalizeServerSnapshot", () => {
  it("normalizes a legacy raw export shape", () => {
    const snapshot = normalizeServerSnapshot({
      target: "https://example.com/mcp",
      exportedAt: "2026-04-13T00:00:00.000Z",
      initInfo: { b: 2, a: 1 },
      capabilities: null,
      tools: [
        { name: "zeta", description: "Second" },
        { name: "alpha", description: "First" },
      ],
      toolsMetadata: {
        zeta: { z: true, a: true },
      },
      resources: [{ uri: "file:///z.txt" }, { uri: "file:///a.txt" }],
      resourceTemplates: [],
      prompts: [{ name: "summarize" }, { name: "annotate" }],
    });

    expect(snapshot).toEqual({
      target: "https://example.com/mcp",
      initInfo: { a: 1, b: 2 },
      capabilities: null,
      tools: [
        { name: "alpha", description: "First" },
        { name: "zeta", description: "Second" },
      ],
      toolsMetadata: {
        zeta: { a: true, z: true },
      },
      resources: [{ uri: "file:///a.txt" }, { uri: "file:///z.txt" }],
      resourceTemplates: [],
      resourceTemplatesSupported: null,
      prompts: [{ name: "annotate" }, { name: "summarize" }],
    });
  });

  it("accepts versioned stable snapshots", () => {
    const result = normalizeServerSnapshot({
      kind: "server-snapshot",
      schemaVersion: 1,
      target: "https://example.com/mcp",
      initInfo: null,
      capabilities: null,
      tools: [],
      toolsMetadata: {},
      resources: [],
      resourceTemplates: [],
      resourceTemplatesSupported: true,
      prompts: [],
    });

    expect(result.target).toBe("https://example.com/mcp");
  });

  it("canonicalizes order-insensitive schema arrays", () => {
    const result = normalizeServerSnapshot({
      kind: "server-snapshot",
      schemaVersion: 1,
      target: "https://example.com/mcp",
      initInfo: null,
      capabilities: null,
      tools: [
        {
          name: "echo",
          inputSchema: {
            enum: ["beta", "alpha"],
            required: ["zeta", "alpha"],
            type: ["string", "null"],
          },
        },
      ],
      toolsMetadata: {},
      resources: [],
      resourceTemplates: [],
      resourceTemplatesSupported: true,
      prompts: [],
    });

    expect(result.tools[0]?.inputSchema).toEqual({
      enum: ["alpha", "beta"],
      required: ["alpha", "zeta"],
      type: ["null", "string"],
    });
  });

  it("rejects unsupported snapshot metadata", () => {
    expect(() =>
      normalizeServerSnapshot({
        kind: "unexpected-kind",
        schemaVersion: 1,
        target: "https://example.com/mcp",
      })
    ).toThrow(ServerSnapshotFormatError);

    expect(() =>
      normalizeServerSnapshot({
        kind: "server-snapshot",
        schemaVersion: 2,
        target: "https://example.com/mcp",
      })
    ).toThrow(ServerSnapshotFormatError);
  });
});
