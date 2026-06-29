import { describe, it, expect, vi } from "vitest";
import type { ListToolsResult } from "@modelcontextprotocol/client";
import {
  convertMCPToolsToVercelTools,
  isAppOnlyTool,
} from "../src/mcp-client-manager/tool-converters.js";
import { MCP_PRESERVE_RAW_RESULT_FOR_UI } from "../src/mcp-client-manager/model-output.js";

const callTool = async () => ({ content: [{ type: "text", text: "ok" }] });

const listToolsFixture: ListToolsResult = {
  tools: [
    {
      name: "app_only",
      description: "Should not be model-facing (SEP-1865 visibility=['app'])",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "model_only",
      description: "Explicitly model-only",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "model_and_app",
      description: "Visible to both",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    {
      name: "default_visibility",
      description: "No visibility field — spec default is ['model','app']",
      inputSchema: { type: "object", properties: {} },
    },
  ],
} as unknown as ListToolsResult;

describe("isAppOnlyTool", () => {
  it("identifies visibility=['app'] as app-only", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["app"] } })).toBe(true);
  });

  it("does not treat ['model','app'] as app-only", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["model", "app"] } })).toBe(false);
  });

  it("does not treat ['model'] as app-only", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["model"] } })).toBe(false);
  });

  it("treats omitted visibility as not app-only (spec default ['model','app'])", () => {
    expect(isAppOnlyTool(undefined)).toBe(false);
    expect(isAppOnlyTool({})).toBe(false);
    expect(isAppOnlyTool({ ui: {} })).toBe(false);
  });

  it("ignores non-array visibility values", () => {
    expect(isAppOnlyTool({ ui: { visibility: "app" } })).toBe(false);
  });
});

describe("convertMCPToolsToVercelTools — SEP-1865 visibility filtering", () => {
  it("excludes visibility=['app'] tools from the model-facing tool set by default", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });

    expect(tools.app_only).toBeUndefined();
    expect(tools.model_only).toBeDefined();
    expect(tools.model_and_app).toBeDefined();
    expect(tools.default_visibility).toBeDefined();
  });

  it("included tools have an executable `execute` function", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });

    expect(typeof (tools.model_only as { execute?: unknown }).execute).toBe(
      "function"
    );
  });

  it("includes app-only tools when includeAppOnly is true (Cursor-template parity)", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
      includeAppOnly: true,
    });

    expect(tools.app_only).toBeDefined();
    expect(tools.model_only).toBeDefined();
    expect(tools.model_and_app).toBeDefined();
    expect(tools.default_visibility).toBeDefined();
  });

  it("maps direct MCP image results through toModelOutput", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });
    const toModelOutput = (tools.default_visibility as any).toModelOutput;

    expect(typeof toModelOutput).toBe("function");
    expect(
      (tools.default_visibility as any)[MCP_PRESERVE_RAW_RESULT_FOR_UI]
    ).toBe(true);
    expect(
      toModelOutput({
        toolCallId: "call-1",
        input: {},
        output: {
          content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
      })
    ).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("maps embedded MCP image resources through toModelOutput", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });
    const toModelOutput = (tools.default_visibility as any).toModelOutput;

    expect(
      toModelOutput({
        toolCallId: "call-1",
        input: {},
        output: {
          content: [
            {
              type: "resource",
              resource: {
                uri: "mcp://images/one",
                blob: "aGVsbG8=",
                mimeType: "image/png",
              },
            },
          ],
        },
      })
    ).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("resolves linked MCP image resources through toModelOutput", async () => {
    const readResource = vi.fn(async ({ uri }: { uri: string }) => ({
      contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
    }));
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
      readResource,
    });
    const toModelOutput = (tools.default_visibility as any).toModelOutput;

    await expect(
      toModelOutput({
        toolCallId: "call-1",
        input: {},
        output: {
          content: [
            {
              type: "resource_link",
              uri: "mcp://images/one",
              name: "one.png",
              mimeType: "image/png",
            },
          ],
        },
      })
    ).resolves.toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(readResource).toHaveBeenCalledWith({
      uri: "mcp://images/one",
      options: undefined,
    });
  });

  it("passes abortSignal to linked MCP resource reads through toModelOutput", async () => {
    const abortController = new AbortController();
    const readResource = vi.fn(
      async ({
        uri,
        options,
      }: {
        uri: string;
        options?: { abortSignal?: AbortSignal };
      }) => ({
        contents: [{ uri, blob: "aGVsbG8=", mimeType: "image/png" }],
        signal: options?.abortSignal,
      })
    );
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
      readResource,
    });
    const toModelOutput = (tools.default_visibility as any).toModelOutput;

    await expect(
      toModelOutput({
        toolCallId: "call-1",
        input: {},
        output: {
          content: [
            {
              type: "resource_link",
              uri: "mcp://images/one",
              name: "one.png",
              mimeType: "image/png",
            },
          ],
        },
        abortSignal: abortController.signal,
      })
    ).resolves.toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(readResource).toHaveBeenCalledWith({
      uri: "mcp://images/one",
      options: { abortSignal: abortController.signal },
    });
  });

  it("omits direct MCP image results when direct images are disabled", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
      modelVisibleMcpToolResults: {
        directContent: { image: false },
      },
    });
    const output = {
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    };

    expect(
      (tools.default_visibility as any).toModelOutput({
        toolCallId: "call-1",
        input: {},
        output,
      })
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "[image omitted: direct image policy disabled]" },
      ],
    });
  });

  it("omits linked MCP image resources when linked images are disabled", async () => {
    const readResource = vi.fn(async () => ({
      contents: [{ blob: "aGVsbG8=", mimeType: "image/png" }],
    }));
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
      readResource,
      modelVisibleMcpToolResults: {
        linkedResources: { blob: { image: false } },
      },
    });
    const output = {
      content: [
        {
          type: "resource_link",
          uri: "mcp://images/one",
          name: "one.png",
          mimeType: "image/png",
        },
      ],
    };

    await expect(
      (tools.default_visibility as any).toModelOutput({
        toolCallId: "call-1",
        input: {},
        output,
      })
    ).resolves.toEqual({
      type: "content",
      value: [
        { type: "text", text: "[resource link omitted: policy disabled]" },
      ],
    });
    expect(readResource).not.toHaveBeenCalled();
  });

  it("keeps text-only MCP results on the JSON fallback path", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });
    const output = {
      content: [{ type: "text", text: "ok" }],
    };

    expect(
      (tools.default_visibility as any).toModelOutput({
        toolCallId: "call-1",
        input: {},
        output,
      })
    ).toEqual({
      type: "json",
      value: output,
    });
  });
});
