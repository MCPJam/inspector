/**
 * End to end: the client the Inspector uses (`MCPClientManager` over the
 * official `@modelcontextprotocol/client`) talking to an in-process MCP
 * server through `createVariantFetch`. The surface is pinned the way the
 * Inspector server must pin it: raw `tools/list` pages, each Tool exactly as
 * the server sent it, because the client's own `listTools` parsing drops
 * fields its schema doesn't know.
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  buildVariantDraft,
  createVariantFetch,
  pinVariantSurface,
} from "../../src/variants/index.js";

const URL_ = "https://base.test/mcp";
const DESCRIPTIONS: Record<string, string> = {
  show_servers: "Lists the servers across every project you can see.",
  list_project_servers: "Lists the servers saved in one project.",
};

const RawToolsPage = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().optional(),
});

/** An in-process MCP server, recording the arguments its tool calls receive. */
function startBase(showDescription = "Show servers.") {
  const calls: unknown[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "variant-base", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    server.registerTool(
      "show_servers",
      {
        description: showDescription,
        inputSchema: { project: z.string() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        calls.push(args);
        return {
          content: [
            { type: "text" as const, text: `servers in ${args.project}` },
          ],
        };
      }
    );
    server.registerTool(
      "list_project_servers",
      {
        description: "List the servers in a project.",
        inputSchema: { project: z.string() },
      },
      async (args) => ({
        content: [{ type: "text" as const, text: `listed ${args.project}` }],
      })
    );
    server.registerTool("whoami", { description: "Who am I." }, async () => ({
      content: [{ type: "text" as const, text: "you" }],
    }));
    return server;
  });
  const fetchBase: typeof fetch = (input, init) =>
    handler.fetch(new Request(input, init));
  return { fetchBase, calls };
}

const managers: MCPClientManager[] = [];
/** Unpinned, the handshake lands on 2026-07-28 and answers JSON; 2025 eras answer SSE. */
type Era = "2025-11-25" | "2025-06-18" | undefined;

async function connect(serverId: string, baseFetch: typeof fetch, era?: Era) {
  const manager = new MCPClientManager();
  managers.push(manager);
  await manager.connectToServer(serverId, {
    url: URL_,
    baseFetch,
    ...(era ? { mcpProtocolVersion: era } : {}),
  });
  return manager;
}

/** Pins `base` through its own connection and drafts the description edits. */
async function draftFrom(
  direct: MCPClientManager,
  descriptions = DESCRIPTIONS
) {
  const client = direct.getManagedClient("base");
  if (!client) throw new Error("the base server isn't connected");
  const pinned = await pinVariantSurface({
    listPage: (cursor) =>
      client.requestWithSchema(
        {
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        RawToolsPage
      ),
  });
  return buildVariantDraft({
    baseServerId: "base-server-id",
    tools: pinned.tools,
    edits: Object.entries(descriptions).map(([target, value]) => ({
      feature: "tools.description",
      target,
      op: "set",
      value,
    })),
  });
}

afterEach(async () => {
  await Promise.all(
    managers.splice(0).map((manager) => manager.disconnectAllServers())
  );
});

describe("a variant served through createVariantFetch", () => {
  it.each([
    ["2026-07-28, answering JSON", undefined],
    ["2025-11-25, answering SSE", "2025-11-25"],
  ] satisfies [string, Era][])(
    "lists the edited descriptions and passes tool calls through unchanged in %s",
    async (_era, era) => {
      const base = startBase();
      const direct = await connect("base", base.fetchBase, era);
      const draft = await draftFrom(direct);
      const sent: unknown[] = [];
      const received: unknown[] = [];
      const types = new Set<string | null>();
      const variantFetch = createVariantFetch({
        baseFetch: async (input, init) => {
          received.push(init?.body);
          const response = await base.fetchBase(input, init);
          if (response.status === 200)
            types.add(response.headers.get("content-type"));
          return response;
        },
        variant: {
          variantId: "variant-1",
          edits: draft.edits,
          toolHashes: draft.toolHashes,
        },
      });
      const viaVariant = await connect(
        "variant",
        (input, init) => {
          sent.push(init?.body);
          return variantFetch(input, init);
        },
        era
      );

      const baseTools = (await direct.listTools("base")).tools;
      const variantTools = (await viaVariant.listTools("variant")).tools;

      expect(baseTools.map((tool) => tool.name)).toEqual([
        "show_servers",
        "list_project_servers",
        "whoami",
      ]);
      expect(variantTools).toEqual(
        baseTools.map((tool) => ({
          ...tool,
          description: DESCRIPTIONS[tool.name] ?? tool.description,
        }))
      );

      const fromBase = await direct.executeTool("base", "show_servers", {
        project: "p1",
      });
      const fromVariant = await viaVariant.executeTool(
        "variant",
        "show_servers",
        { project: "p1" }
      );

      expect(fromVariant).toEqual(fromBase);
      expect(base.calls).toEqual([{ project: "p1" }, { project: "p1" }]);
      // Every request the client sent through the variant reached the base as sent.
      expect(received).toEqual(sent);
      expect(
        sent.some(
          (body) =>
            typeof body === "string" && JSON.parse(body).method === "tools/call"
        )
      ).toBe(true);
      expect([...types]).toEqual([
        era ? "text/event-stream" : "application/json",
      ]);
    }
  );

  it("refuses tools/list with VARIANT_BASE_DRIFTED once the base changes an edited tool", async () => {
    const direct = await connect("base", startBase().fetchBase);
    const draft = await draftFrom(direct);
    const changed = startBase("Show every server.");
    const viaVariant = await connect(
      "variant",
      createVariantFetch({
        baseFetch: changed.fetchBase,
        variant: {
          variantId: "variant-1",
          edits: draft.edits,
          toolHashes: draft.toolHashes,
        },
      })
    );

    await expect(viaVariant.listTools("variant")).rejects.toMatchObject({
      code: -32090,
      data: {
        code: "VARIANT_BASE_DRIFTED",
        tools: ["show_servers"],
        variantId: "variant-1",
      },
    });
    const call = await viaVariant.executeTool("variant", "show_servers", {
      project: "p2",
    });
    expect(call).toMatchObject({
      content: [{ type: "text", text: "servers in p2" }],
    });
  });

  it("serves a tool pinned over 2026-07-28 to 2025 sessions, which list it with more fields", async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer(
        { name: "era-base", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      server.server.setRequestHandler("tools/list", () => ({
        tools: [
          {
            name: "long_job",
            description: "Runs a long job.",
            inputSchema: { type: "object" },
            execution: { taskSupport: "optional" },
          },
        ],
      }));
      return server;
    });
    const fetchBase: typeof fetch = (input, init) =>
      handler.fetch(new Request(input, init));
    const listed = async (era: Era) =>
      (
        await (
          await connect(`base-${era}`, fetchBase, era)
        ).listTools(`base-${era}`)
      ).tools[0];
    // The server SDK drops `execution` from 2026-07-28 listings only.
    expect((await listed(undefined)).execution).toBeUndefined();
    expect((await listed("2025-11-25")).execution).toEqual({
      taskSupport: "optional",
    });

    const draft = await draftFrom(await connect("base", fetchBase), {
      long_job: "Runs one long job in the background.",
    });
    for (const era of ["2025-11-25", "2025-06-18"] satisfies Era[]) {
      const viaVariant = await connect(
        `variant-${era}`,
        createVariantFetch({
          baseFetch: fetchBase,
          variant: {
            variantId: "variant-1",
            edits: draft.edits,
            toolHashes: draft.toolHashes,
          },
        }),
        era
      );
      const { tools } = await viaVariant.listTools(`variant-${era}`);
      expect(tools[0]?.description).toBe(
        "Runs one long job in the background."
      );
    }
  });
});
