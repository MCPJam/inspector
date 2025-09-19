import { MCPJamClientManager } from "./mcpjam-client-manager";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Unify JSON-RPC handling used by adapter-http and manager-http routes
// while preserving their minor response-shape differences.

export type BridgeMode = "adapter" | "manager";

type JsonRpcBody = {
  id?: string | number | null;
  method?: string;
  params?: any;
};

export function buildInitializeResult(serverId: string, mode: BridgeMode) {
  if (mode === "adapter") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: { listChanged: true, subscribe: true },
        logging: {},
        roots: { listChanged: true },
      },
      serverInfo: { name: serverId, version: "stdio-adapter" },
    };
  }
  // manager mode (SSE transport facade)
  return {
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: true,
      prompts: true,
      resources: true,
      logging: false,
      elicitation: {},
      roots: { listChanged: true },
    },
    serverInfo: { name: serverId, version: "mcpjam-proxy" },
  };
}

function toJsonSchemaMaybe(schema: any): any {
  try {
    if (schema && typeof schema === "object") {
      // Detect Zod schema heuristically
      if (
        schema instanceof z.ZodType ||
        ("_def" in schema && "parse" in schema)
      ) {
        return zodToJsonSchema(schema as z.ZodType<any>);
      }
    }
  } catch {}
  return schema;
}

export async function handleJsonRpc(
  serverId: string,
  body: JsonRpcBody,
  clientManager: MCPJamClientManager,
  mode: BridgeMode,
): Promise<any | null> {
  const id = (body?.id ?? null) as any;
  const method = body?.method as string | undefined;
  const params = body?.params ?? {};

  // Treat missing method and notifications/* as notifications (no response envelope)
  if (!method || method.startsWith("notifications/")) {
    return null;
  }

  const respond = (payload: any) => ({ jsonrpc: "2.0", id, ...payload });

  try {
    switch (method) {
      case "ping":
        return respond({ result: {} });
      case "initialize": {
        const result = buildInitializeResult(serverId, mode);
        return respond({ result });
      }
      case "tools/list": {
        const toolsets = await clientManager.getToolsetsForServer(serverId);
        const tools = Object.keys(toolsets).map((name) => ({
          name,
          description: (toolsets as any)[name].description,
          inputSchema: toJsonSchemaMaybe((toolsets as any)[name].inputSchema),
          outputSchema: toJsonSchemaMaybe((toolsets as any)[name].outputSchema),
        }));
        return respond({ result: { tools } });
      }
      case "tools/call": {
        try {
          const exec = await clientManager.executeToolDirect(
            `${serverId}:${params?.name}`,
            params?.arguments || {},
          );
          if (mode === "manager") {
            // Spec-style CallToolResult
            const result = {
              content: [
                {
                  type: "text",
                  text:
                    typeof (exec as any).result === "string"
                      ? (exec as any).result
                      : JSON.stringify((exec as any).result, null, 2),
                },
              ],
              isError: false,
            };
            return respond({ result });
          }
          // adapter mode returns raw result
          return respond({ result: (exec as any).result });
        } catch (e: any) {
          if (mode === "manager") {
            const result = {
              content: [
                { type: "text", text: `Error: ${e?.message || String(e)}` },
              ],
              isError: true,
            };
            return respond({ result });
          }
          return respond({
            error: { code: -32000, message: e?.message || String(e) },
          });
        }
      }
      case "resources/list": {
        const resources = clientManager
          .getResourcesForServer(serverId)
          .map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          }));
        return respond({ result: { resources } });
      }
      case "resources/read": {
        try {
          const content = await clientManager.getResource(
            params?.uri,
            serverId,
          );
          if (mode === "manager") {
            const result = {
              contents: [
                {
                  uri: params?.uri,
                  mimeType: (content as any)?.mimeType || "text/plain",
                  text:
                    typeof content === "string"
                      ? content
                      : JSON.stringify(content, null, 2),
                },
              ],
            };
            return respond({ result });
          }
          // adapter mode returns raw content
          return respond({ result: content });
        } catch (e: any) {
          return respond({
            error: { code: -32000, message: e?.message || String(e) },
          });
        }
      }
      case "prompts/list": {
        const prompts = clientManager
          .getPromptsForServer(serverId)
          .map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          }));
        return respond({ result: { prompts } });
      }
      case "prompts/get": {
        try {
          const content = await clientManager.getPrompt(
            params?.name,
            serverId,
            params?.arguments || {},
          );
          if (mode === "manager") {
            const result = {
              description:
                (content as any)?.description || `Prompt: ${params?.name}`,
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text:
                      typeof content === "string"
                        ? content
                        : JSON.stringify(content, null, 2),
                  },
                },
              ],
            };
            return respond({ result });
          }
          // adapter mode returns raw content
          return respond({ result: content });
        } catch (e: any) {
          return respond({
            error: { code: -32000, message: e?.message || String(e) },
          });
        }
      }
      case "roots/list": {
        return respond({ result: { roots: [] } });
      }
      case "logging/setLevel": {
        return respond({ result: { success: true } });
      }
      default: {
        return respond({
          error: { code: -32601, message: `Method not implemented: ${method}` },
        });
      }
    }
  } catch (e: any) {
    return respond({
      error: { code: -32000, message: e?.message || String(e) },
    });
  }
}
