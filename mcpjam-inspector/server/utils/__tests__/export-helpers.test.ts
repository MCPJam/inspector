import { describe, it, expect, vi } from "vitest";
import { exportServer } from "../export-helpers.js";

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
