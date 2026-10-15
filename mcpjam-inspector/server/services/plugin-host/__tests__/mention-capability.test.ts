import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMentions } from "@openai/mcp-extensions/server";
import {
  isPluginMentionSearchTool,
  pluginMentionsCapability,
  pluginMentionSearchTool,
} from "../../../../shared/plugin-mentions.js";

const searchTool = {
  name: "parts.search",
  annotations: { readOnlyHint: true },
  _meta: { ui: { visibility: ["app"] } },
};
const legacyTool = {
  name: "legacy.search",
  _meta: {
    "openai/extensions": { "mentions/search": {} },
    ui: { visibility: ["app"] },
  },
};
const capability = (searchTool: unknown) => ({
  extensions: { "openai/mentions": { searchTool } },
});
const codes = (result: { diagnostics: { code: string }[] }) =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

describe("openai/mentions capability", () => {
  it("names a search tool that has no legacy declaration", () => {
    const result = pluginMentionSearchTool(
      {
        tools: [searchTool, legacyTool],
        serverCapabilities: capability("parts.search"),
        transport: "mrtr",
      },
      "server-1",
    );
    expect(result).toEqual({ tool: searchTool, diagnostics: [] });
    // The capability decides: the deprecated marker elsewhere is ignored.
    expect(
      isPluginMentionSearchTool(legacyTool, {
        serverCapabilities: capability("parts.search"),
        transport: "mrtr",
      }),
    ).toBe(false);
  });
  it.each([
    [
      "readOnlyHint missing",
      { ...searchTool, annotations: {} },
      "PLUGIN_MENTION_SEARCH_TOOL_NOT_READ_ONLY",
    ],
    [
      "not visible to Apps",
      { ...searchTool, _meta: { ui: { visibility: ["model"] } } },
      "PLUGIN_MENTION_SEARCH_TOOL_NOT_APP_VISIBLE",
    ],
  ])(
    "refuses a search tool with %s, explained in Logs",
    (_case, tool, code) => {
      const result = pluginMentionSearchTool(
        {
          tools: [tool],
          serverCapabilities: capability("parts.search"),
          transport: "legacy",
        },
        "server-1",
      );
      expect(result.tool).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          level: "warning",
          code,
          serverId: "server-1",
          details: { tool: "parts.search" },
        }),
      ]);
      expect(
        isPluginMentionSearchTool(tool, {
          serverCapabilities: capability("parts.search"),
          transport: "legacy",
        }),
      ).toBe(false);
    },
  );
  it("refuses a capability naming a tool the server does not list", () => {
    expect(
      codes(
        pluginMentionSearchTool(
          {
            tools: [legacyTool],
            serverCapabilities: capability("missing"),
            transport: "mrtr",
          },
          "server-1",
        ),
      ),
    ).toEqual(["PLUGIN_MENTION_SEARCH_TOOL_MISSING"]);
  });
  it.each([" ", 7, undefined])("refuses a malformed searchTool %j", (name) => {
    expect(() => pluginMentionsCapability(capability(name), "legacy")).toThrow(
      "PLUGIN_MENTION_CAPABILITY_INVALID",
    );
    expect(
      codes(
        pluginMentionSearchTool(
          {
            tools: [searchTool],
            serverCapabilities: capability(name),
            transport: "legacy",
          },
          "server-1",
        ),
      ),
    ).toEqual(["PLUGIN_MENTION_CAPABILITY_INVALID"]);
  });
  it("falls back to the deprecated declaration only without the capability", () => {
    expect(
      pluginMentionSearchTool(
        { tools: [searchTool, legacyTool], transport: "mrtr" },
        "server-1",
      ),
    ).toEqual({ tool: legacyTool, diagnostics: [] });
    expect(
      codes(
        pluginMentionSearchTool(
          {
            tools: [legacyTool, { ...legacyTool, name: "other" }],
            transport: "legacy",
          },
          "server-1",
        ),
      ),
    ).toEqual(["PLUGIN_MENTION_DECLARATION_AMBIGUOUS"]);
    expect(
      pluginMentionSearchTool({ tools: [searchTool] }, "server-1"),
    ).toEqual({ diagnostics: [] });
  });
  it("reads experimental only on legacy connections", () => {
    const experimental = {
      experimental: { "openai/mentions": { searchTool: "parts.search" } },
    };
    expect(pluginMentionsCapability(experimental, "legacy")).toEqual({
      searchTool: "parts.search",
    });
    expect(pluginMentionsCapability(experimental, "mrtr")).toBeUndefined();
    // On 2026-07-28 the experimental copy is ignored, so it can't conflict.
    const both = {
      ...capability("parts.search"),
      experimental: { "openai/mentions": { searchTool: "other" } },
    };
    expect(pluginMentionsCapability(both, "mrtr")).toEqual({
      searchTool: "parts.search",
    });
    expect(() => pluginMentionsCapability(both, "legacy")).toThrow(
      "PLUGIN_MENTION_CAPABILITY_AMBIGUOUS",
    );
  });
});

describe("OpenAI's mention helper over a real MCP wire", () => {
  const close: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(close.splice(0).map((fn) => fn()));
  });
  it("resolves the helper's capability and tool declaration to one tool", async () => {
    const server = new McpServer({ name: "disposable-mentions", version: "1" });
    createMentions(server).setHandler(() => ({ items: [] }));
    const client = new Client({ name: "fixture-host", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(
      () => client.close(),
      () => server.close(),
    );
    const { tools } = await client.listTools();
    const result = pluginMentionSearchTool(
      {
        tools,
        serverCapabilities: client.getServerCapabilities(),
        transport: "legacy",
      },
      "server-1",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.tool?.name).toBe("search_mentions");
    expect(
      pluginMentionsCapability(client.getServerCapabilities(), "legacy"),
    ).toEqual({ searchTool: "search_mentions" });
  });
});
