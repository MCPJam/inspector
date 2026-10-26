import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import { WEBMCP_APP_CONTRACT } from "./webmcp-contract.js";
import { mcpAppToolResultSchema } from "./tool-result-schema.js";

export type AppToolSource = "mcp-apps" | "webmcp";
export type AppToolDescriptor = NonNullable<
  Awaited<ReturnType<AppBridge["listTools"]>>["tools"]
>[number];

export interface SandboxToolsRequester {
  request(
    request: { method: string; params?: object },
    schema: z.ZodType,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

const toolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    description: z.string().min(1),
    inputSchema: z.object({ type: z.literal("object") }).passthrough(),
    annotations: z
      .object({ readOnlyHint: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const listSchema = z.object({
  tools: z.array(toolSchema).max(WEBMCP_APP_CONTRACT.maxTools),
});

export function appToolSourceFor(
  appCapabilities: { tools?: unknown } | undefined,
  hostCapabilities: { webmcpTools?: boolean }
): AppToolSource | null {
  if (appCapabilities?.tools) return "mcp-apps";
  return hostCapabilities.webmcpTools === true ? "webmcp" : null;
}

export async function listViewWebmcpTools(
  requester: SandboxToolsRequester,
  options?: { signal?: AbortSignal }
): Promise<AppToolDescriptor[]> {
  const result = await requester.request(
    { method: WEBMCP_APP_CONTRACT.list },
    listSchema,
    options
  );
  return listSchema.parse(result).tools;
}

export async function callViewWebmcpTool(
  requester: SandboxToolsRequester,
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) {
  const result = await requester.request(
    { method: WEBMCP_APP_CONTRACT.call, params: { name, arguments: args } },
    mcpAppToolResultSchema,
    options
  );
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    WEBMCP_APP_CONTRACT.maxResultBytes
  ) {
    throw new Error("WebMCP app tool result exceeds the 256 KiB limit");
  }
  return mcpAppToolResultSchema.parse(result);
}

/** Only initial discovery may fall back; an execution is never retried. */
export async function discoverViewAppTools(
  requester: SandboxToolsRequester,
  source: AppToolSource,
  webmcpEnabled: boolean,
  listLegacy: () => Promise<AppToolDescriptor[]>
) {
  if (source === "mcp-apps") {
    try {
      return { source, tools: await listLegacy() };
    } catch (error) {
      if (
        !webmcpEnabled ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== -32601
      )
        throw error;
    }
  }
  return {
    source: "webmcp" as const,
    tools: await listViewWebmcpTools(requester),
  };
}
