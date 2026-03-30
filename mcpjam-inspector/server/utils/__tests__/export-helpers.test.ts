import { describe, it, expect, vi } from "vitest";
import {
  buildServerToolSnapshotDebug,
  exportConnectedServerToolSnapshotForEvalAuthoring,
  exportServer,
  renderServerToolSnapshotSection,
} from "../export-helpers.js";

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    ...overrides,
  } as any;
}

describe("exportServer", () => {
  it("returns tools, resources, and prompts for a server", async () => {
    const manager = createMockManager({
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object" },
            outputSchema: { type: "string" },
            extra: "ignored",
          },
        ],
      }),
      listResources: vi.fn().mockResolvedValue({
        resources: [
          {
            uri: "file:///a.txt",
            name: "a.txt",
            description: "A text file",
            mimeType: "text/plain",
            extra: "ignored",
          },
        ],
      }),
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          {
            name: "summarize",
            description: "Summarize text",
            arguments: [{ name: "text", required: true }],
            extra: "ignored",
          },
        ],
      }),
    });

    const result = await exportServer(manager, "my-server");

    expect(manager.listTools).toHaveBeenCalledWith("my-server");
    expect(manager.listResources).toHaveBeenCalledWith("my-server");
    expect(manager.listPrompts).toHaveBeenCalledWith("my-server");

    expect(result.serverId).toBe("my-server");
    expect(result.exportedAt).toBeDefined();
    expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);

    expect(result.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
      },
    ]);

    expect(result.resources).toEqual([
      {
        uri: "file:///a.txt",
        name: "a.txt",
        description: "A text file",
        mimeType: "text/plain",
      },
    ]);

    expect(result.prompts).toEqual([
      {
        name: "summarize",
        description: "Summarize text",
        arguments: [{ name: "text", required: true }],
      },
    ]);
  });

  it("returns empty arrays when server has no capabilities", async () => {
    const manager = createMockManager();

    const result = await exportServer(manager, "empty-server");

    expect(result.serverId).toBe("empty-server");
    expect(result.tools).toEqual([]);
    expect(result.resources).toEqual([]);
    expect(result.prompts).toEqual([]);
  });

  it("strips extra fields from exported objects", async () => {
    const manager = createMockManager({
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "t",
            description: "d",
            inputSchema: {},
            outputSchema: {},
            annotations: { title: "T" },
            _meta: { internal: true },
          },
        ],
      }),
      listResources: vi.fn().mockResolvedValue({
        resources: [
          {
            uri: "file:///x",
            name: "x",
            description: "X",
            mimeType: "text/plain",
            size: 1024,
            _internal: true,
          },
        ],
      }),
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [
          {
            name: "p",
            description: "P",
            arguments: [],
            _meta: { hidden: true },
          },
        ],
      }),
    });

    const result = await exportServer(manager, "srv");

    expect(Object.keys(result.tools[0])).toEqual([
      "name",
      "description",
      "inputSchema",
      "outputSchema",
    ]);
    expect(Object.keys(result.resources[0])).toEqual([
      "uri",
      "name",
      "description",
      "mimeType",
    ]);
    expect(Object.keys(result.prompts[0])).toEqual([
      "name",
      "description",
      "arguments",
    ]);
  });

  it("propagates manager errors", async () => {
    const manager = createMockManager({
      listTools: vi.fn().mockRejectedValue(new Error("not connected")),
    });

    await expect(exportServer(manager, "srv")).rejects.toThrow("not connected");
  });
});

describe("exportConnectedServerToolSnapshotForEvalAuthoring", () => {
  it("captures tools per connected server in deterministic order", async () => {
    const manager = createMockManager({
      listTools: vi.fn().mockImplementation(async (serverId: string) => {
        if (serverId === "zebra") {
          return {
            tools: [
              {
                name: "later_tool",
                description: "Runs later",
                inputSchema: { z: true },
              },
              {
                name: "alpha_tool",
                description: "Runs first",
                inputSchema: { a: true },
                outputSchema: { done: true },
              },
            ],
          };
        }
        return {
          tools: [
            {
              name: "single_tool",
              description: "Only tool",
              inputSchema: { type: "object" },
            },
          ],
        };
      }),
    });

    const snapshot = await exportConnectedServerToolSnapshotForEvalAuthoring(
      manager,
      ["zebra", "alpha", "zebra"],
    );

    expect(snapshot).toEqual({
      version: 1,
      capturedAt: expect.any(Number),
      servers: [
        {
          serverId: "alpha",
          tools: [
            {
              name: "single_tool",
              description: "Only tool",
              inputSchema: { type: "object" },
            },
          ],
        },
        {
          serverId: "zebra",
          tools: [
            {
              name: "alpha_tool",
              description: "Runs first",
              inputSchema: { a: true },
              outputSchema: { done: true },
            },
            {
              name: "later_tool",
              description: "Runs later",
              inputSchema: { z: true },
            },
          ],
        },
      ],
    });
    expect(manager.listTools).toHaveBeenCalledTimes(2);
  });

  it("stores per-server capture errors without failing the snapshot export", async () => {
    const manager = createMockManager({
      listTools: vi.fn().mockImplementation(async (serverId: string) => {
        if (serverId === "offline") {
          throw new Error('MCP server "offline" is not connected.');
        }
        if (serverId === "broken") {
          throw new Error("list failed");
        }
        return {
          tools: [
            {
              name: "ok_tool",
              description: "Still captured",
              inputSchema: { type: "object" },
            },
          ],
        };
      }),
    });

    const snapshot = await exportConnectedServerToolSnapshotForEvalAuthoring(
      manager,
      ["healthy", "broken", "offline"],
    );

    expect(snapshot.servers).toEqual([
      {
        serverId: "broken",
        tools: [],
        captureError: "list failed",
      },
      {
        serverId: "healthy",
        tools: [
          {
            name: "ok_tool",
            description: "Still captured",
            inputSchema: { type: "object" },
          },
        ],
      },
      {
        serverId: "offline",
        tools: [],
        captureError: 'MCP server "offline" is not connected.',
      },
    ]);
    expect(manager.listTools).toHaveBeenCalledTimes(3);
  });
});

describe("renderServerToolSnapshotSection", () => {
  it("drops output schemas before input schemas when truncating", () => {
    const snapshot = {
      version: 1,
      capturedAt: 1,
      servers: [
        {
          serverId: "alpha",
          tools: [
            {
              name: "search_catalog",
              description:
                "Search the product catalog after auth is established.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  filters: { type: "string", description: "x".repeat(120) },
                },
              },
              outputSchema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        title: { type: "string", description: "y".repeat(220) },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    } as const;

    const full = renderServerToolSnapshotSection(snapshot, {
      maxChars: Number.MAX_SAFE_INTEGER,
    }).promptSection!;
    const withoutOutput = renderServerToolSnapshotSection(
      {
        ...snapshot,
        servers: [
          {
            ...snapshot.servers[0],
            tools: [
              {
                ...snapshot.servers[0].tools[0],
                outputSchema: undefined,
              },
            ],
          },
        ],
      },
      { maxChars: Number.MAX_SAFE_INTEGER },
    ).promptSection!;
    const withoutSchemas = renderServerToolSnapshotSection(
      {
        ...snapshot,
        servers: [
          {
            ...snapshot.servers[0],
            tools: [
              {
                name: snapshot.servers[0].tools[0].name,
                description: snapshot.servers[0].tools[0].description,
              },
            ],
          },
        ],
      },
      { maxChars: Number.MAX_SAFE_INTEGER },
    ).promptSection!;

    expect(full.length).toBeGreaterThan(withoutOutput.length);
    expect(withoutOutput.length).toBeGreaterThan(withoutSchemas.length);

    const outputTrimmed = renderServerToolSnapshotSection(snapshot, {
      maxChars: withoutOutput.length,
    });
    expect(outputTrimmed.truncated).toBe(true);
    expect(outputTrimmed.promptSection).toContain("inputSchema:");
    expect(outputTrimmed.promptSection).not.toContain("outputSchema:");

    const schemasTrimmed = renderServerToolSnapshotSection(snapshot, {
      maxChars: withoutSchemas.length,
    });
    expect(schemasTrimmed.truncated).toBe(true);
    expect(schemasTrimmed.promptSection).toContain("`search_catalog`");
    expect(schemasTrimmed.promptSection).toContain(
      "Search the product catalog after auth is established.",
    );
    expect(schemasTrimmed.promptSection).not.toContain("inputSchema:");
    expect(schemasTrimmed.promptSection).not.toContain("outputSchema:");
  });
});

describe("buildServerToolSnapshotDebug", () => {
  it("returns capture summary, fallback reason, rendered section, and full snapshot", () => {
    const snapshot = {
      version: 1,
      capturedAt: 123,
      servers: [
        {
          serverId: "alpha",
          tools: [
            {
              name: "bootstrap",
              description: "Call this before any other tool.",
              inputSchema: { type: "object" },
            },
          ],
        },
        {
          serverId: "beta",
          tools: [],
          captureError: "timeout",
        },
      ],
    };

    expect(buildServerToolSnapshotDebug(snapshot, { maxChars: 1200 })).toEqual({
      captureResult: {
        status: "partial",
        serverCount: 2,
        toolCount: 1,
        failedServerCount: 1,
        failedServerIds: ["beta"],
      },
      promptSection: expect.stringContaining("# Available MCP Tools"),
      promptSectionTruncated: false,
      promptSectionMaxChars: 1200,
      fallbackReason: "tool_snapshot_partial_capture",
      fullSnapshot: snapshot,
    });
  });
});
