import { MCPClientManager, describeError } from "@mcpjam/sdk";
import { z } from "zod";

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
        return z.toJSONSchema(schema as z.ZodType<any>);
      }
    }
  } catch {}
  return schema;
}

export async function handleJsonRpc(
  serverId: string,
  body: JsonRpcBody,
  clientManager: MCPClientManager,
  mode: BridgeMode
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
        // Mirror the real upstream handshake (capabilities, serverInfo,
        // instructions) so remote clients negotiate against what the
        // connected server actually supports. The fabricated result is
        // only a fallback for servers that haven't connected yet.
        const info = clientManager.getInitializationInfo(serverId);
        if (info) {
          const result: any = {
            protocolVersion:
              info.protocolVersion ??
              (typeof params?.protocolVersion === "string"
                ? params.protocolVersion
                : "2025-06-18"),
            capabilities: info.serverCapabilities ?? {},
            serverInfo:
              info.serverVersion ??
              ({ name: serverId, version: "unknown" } as any),
          };
          if (info.instructions !== undefined) {
            result.instructions = info.instructions;
          }
          return respond({ result });
        }
        return respond({ result: buildInitializeResult(serverId, mode) });
      }
      case "tools/list": {
        const list = await clientManager.listTools(serverId);
        const tools = (list?.tools ?? []).map((tool: any) => {
          const mappedTool: any = {
            name: tool.name,
            description: tool.description,
            inputSchema: toJsonSchemaMaybe(tool.inputSchema),
            outputSchema: toJsonSchemaMaybe(
              tool.outputSchema ?? tool.resultSchema
            ),
          };
          // Preserve _meta field for OpenAI Apps SDK and other metadata
          if (tool._meta) {
            mappedTool._meta = tool._meta;
          }
          return mappedTool;
        });
        return respond({ result: { tools } });
      }
      case "tools/call": {
        try {
          let targetServerId = serverId;
          let toolName = params?.name as string | undefined;
          if (toolName?.includes(":")) {
            const [prefix, actualName] = toolName.split(":", 2);
            if (actualName) {
              if (clientManager.hasServer(prefix)) {
                targetServerId = prefix;
              }
              toolName = actualName;
            }
          }
          if (!toolName) {
            throw new Error("Tool name is required");
          }
          const exec = await clientManager.executeTool(
            targetServerId,
            toolName,
            (params?.arguments ?? {}) as Record<string, unknown>
          );
          if (mode === "manager") {
            return respond({ result: exec });
          }
          // adapter mode returns raw call-tool result for compatibility
          return respond({ result: exec });
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
            error: {
              code: -32000,
              message: e?.message || String(e),
              data: { normalized: describeError(e) },
            },
          });
        }
      }
      case "resources/list": {
        const list = await clientManager.listResources(serverId);
        const resources = (list?.resources ?? []).map((r: any) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
        return respond({ result: { resources } });
      }
      case "resources/read": {
        try {
          const resource = await clientManager.readResource(serverId, {
            uri: params?.uri,
          });
          if (mode === "manager") {
            const firstContent = (resource as any)?.contents?.[0];
            const text =
              typeof firstContent?.text === "string"
                ? firstContent.text
                : typeof (resource as any) === "string"
                ? (resource as any)
                : JSON.stringify(resource, null, 2);
            const result = {
              contents: [
                {
                  uri: params?.uri,
                  mimeType:
                    firstContent?.mimeType ||
                    (typeof text === "string" ? "text/plain" : undefined),
                  text,
                },
              ],
            };
            return respond({ result });
          }
          // adapter mode returns raw content
          return respond({ result: resource });
        } catch (e: any) {
          return respond({
            error: {
              code: -32000,
              message: e?.message || String(e),
              data: { normalized: describeError(e) },
            },
          });
        }
      }
      case "prompts/list": {
        const list = await clientManager.listPrompts(serverId);
        const prompts = (list?.prompts ?? []).map((p: any) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
        return respond({ result: { prompts } });
      }
      case "prompts/get": {
        try {
          const prompt = await clientManager.getPrompt(serverId, {
            name: params?.name,
            arguments: params?.arguments,
          });
          if (mode === "manager") {
            const result = {
              description:
                (prompt as any)?.description || `Prompt: ${params?.name}`,
              messages: (prompt as any)?.messages ?? [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: JSON.stringify(prompt, null, 2),
                  },
                },
              ],
            };
            return respond({ result });
          }
          // adapter mode returns raw content
          return respond({ result: prompt });
        } catch (e: any) {
          return respond({
            error: {
              code: -32000,
              message: e?.message || String(e),
              data: { normalized: describeError(e) },
            },
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
        // Transparent passthrough: any method without bespoke response
        // shaping above is forwarded verbatim to the connected server
        // (resources/templates/list, resources/subscribe,
        // completion/complete, tasks/*, future spec methods, ...).
        const managed = clientManager.getManagedClient(serverId);
        if (managed) {
          try {
            const result = await managed.request({ method, params } as any);
            return respond({ result: result ?? {} });
          } catch (e: any) {
            return respond({
              error: {
                code: -32000,
                message: e?.message || String(e),
                data: { normalized: describeError(e) },
              },
            });
          }
        }
        const notImpl = new Error(`Method not implemented: ${method}`);
        return respond({
          error: {
            code: -32601,
            message: notImpl.message,
            data: { normalized: describeError(notImpl) },
          },
        });
      }
    }
  } catch (e: any) {
    return respond({
      error: {
        code: -32000,
        message: e?.message || String(e),
        data: { normalized: describeError(e) },
      },
    });
  }
}
