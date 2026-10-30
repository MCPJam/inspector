import type { MCPClientManager } from "@mcpjam/sdk";
import { isVisibleToAppOnly } from "@mcpjam/sdk/widget-runtime";
import { handleJsonRpc } from "../../../services/mcp-http-bridge.js";
import { isRecord } from "../../byok/list-request.js";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import type { NativeMessage } from "./native-wire.js";
import type { Settlement } from "./execution-control.js";
import { enhancedModelOutput } from "./enhanced-model-output.js";

export async function enhancedToolPolicy(
  manager: MCPClientManager,
  serverId: string,
  message: NativeMessage | undefined,
  policy: ToolPolicySnapshot,
  respectVisibility: boolean,
  signal?: AbortSignal,
) {
  if (!respectVisibility || message?.method !== "tools/call") return policy;
  const catalog = await manager.listTools(serverId, undefined, {
    cacheMode: "bypass",
    signal,
  });
  const hidden = catalog.tools.filter((tool) => isVisibleToAppOnly(tool._meta));
  return {
    ...policy,
    denied: {
      ...policy.denied,
      ...Object.fromEntries(
        hidden.map((tool) => [
          tool.name,
          { reason: "denyList" as const, classification: "unknown" as const },
        ]),
      ),
    },
  };
}

/** The official SDK owns the modern upstream; the CLI keeps its own downstream protocol. */
export async function enhancedMcpResponse(args: {
  manager: MCPClientManager;
  serverId: string;
  message?: NativeMessage;
  signal: AbortSignal;
  respectVisibility: boolean;
  settle?: (value: Settlement) => Promise<void>;
  modelOutput?: Parameters<typeof enhancedModelOutput>[2];
}): Promise<Response> {
  if (
    args.manager.getInitializationInfo(args.serverId)?.protocolVersion !==
    "2026-07-28"
  )
    throw new Error(
      "The enhanced App connection requires the stateless MCP protocol.",
    );
  if (!args.message) return new Response(null, { status: 405 });
  const params = args.message.params;
  const response: unknown = await handleJsonRpc(
    args.serverId,
    args.message,
    args.manager,
    "adapter",
    {
      signal: args.signal,
      downstreamProtocolVersion:
        args.message.method === "initialize" &&
        isRecord(params) &&
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : undefined,
    },
  );
  if (response === null) return new Response(null, { status: 202 });
  const raw = JSON.stringify(response);
  if (!isRecord(response)) throw new Error("Invalid enhanced MCP response.");
  await args.settle?.({
    outcome:
      "error" in response
        ? "protocol_error"
        : isRecord(response.result) && response.result.isError === true
          ? "tool_error"
          : "success",
    resultJson: raw,
  });
  let delivered = response;
  if (args.message.method === "tools/call" && isRecord(response.result)) {
    const catalog = await args.manager.listTools(args.serverId, undefined, {
      signal: args.signal,
    });
    const tool = catalog.tools.find(
      (entry) => entry.name === (isRecord(params) ? params.name : undefined),
    );
    if (!tool) throw new Error("The model tool is no longer available.");
    delivered = {
      ...response,
      result: await enhancedModelOutput(response.result, tool._meta, {
        ...args.modelOutput,
        abortSignal: args.signal,
      }),
    };
  }
  if (
    args.respectVisibility &&
    args.message.method === "tools/list" &&
    isRecord(response.result) &&
    Array.isArray(response.result.tools)
  )
    delivered = {
      ...response,
      result: {
        ...response.result,
        tools: response.result.tools.filter(
          (tool: unknown) =>
            !isRecord(tool) ||
            !isRecord(tool._meta) ||
            !isVisibleToAppOnly(tool._meta),
        ),
      },
    };
  return Response.json(delivered);
}
