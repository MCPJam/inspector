import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import type {
  McpHttpHandler,
  ServerCapabilities,
} from "@modelcontextprotocol/server";
import type { MockDefinition } from "./definition-types.js";
import {
  editedToolMissingError,
  methodUnavailableError,
  realUnreachableError,
  toolNotFoundError,
} from "./mock-errors.js";
import { NO_REAL_SERVER } from "./real-server.js";
import type { MockRealServer, MockRealServerInfo } from "./real-server.js";
import { callerLogLevel, relayDuringCall } from "./relay.js";
import { planToolCall, resolveMockTools } from "./resolve-tools.js";

/** Which capability each family of methods needs; other methods pass to the real server as they are. */
const METHOD_FAMILIES: Array<
  [prefix: string, capability: keyof ServerCapabilities]
> = [
  ["resources/", "resources"],
  ["prompts/", "prompts"],
  ["completion/", "completions"],
  ["tasks/", "tasks"],
  ["logging/", "logging"],
];

/** The real server's capabilities with the definition's laid over them; `null` removes one. */
function effectiveCapabilities(
  real: ServerCapabilities,
  definition: MockDefinition
): ServerCapabilities {
  const merged: Record<string, unknown> = { ...real, tools: real.tools ?? {} };
  for (const [key, value] of Object.entries(definition.capabilities ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged as ServerCapabilities;
}

function unreachableServer(error: Error): Server {
  const server = new Server(
    { name: "mcpjam-mock", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const refuse = async (): Promise<never> => {
    throw error;
  };
  server.setRequestHandler("tools/list", refuse);
  server.setRequestHandler("tools/call", refuse);
  server.fallbackRequestHandler = refuse;
  return server;
}

async function buildServer(
  definition: MockDefinition,
  real: MockRealServer,
  signal?: AbortSignal
): Promise<Server> {
  let info: MockRealServerInfo;
  try {
    info = await real.describe({ signal });
  } catch (cause) {
    // A factory that throws is masked as a generic internal error, so serve a
    // server that answers every request with the reason instead.
    return unreachableServer(realUnreachableError(cause));
  }
  const mockCapabilities = effectiveCapabilities(info.capabilities, definition);
  const name =
    definition.serverInfo?.name ?? info.serverInfo?.name ?? "mcpjam-mock";
  const server = new Server(
    {
      ...info.serverInfo,
      ...definition.serverInfo,
      name,
      version:
        definition.serverInfo?.version ?? info.serverInfo?.version ?? "1.0.0",
    },
    {
      capabilities: mockCapabilities,
      ...((definition.instructions ?? info.instructions) !== undefined && {
        instructions: definition.instructions ?? info.instructions,
      }),
    }
  );

  server.setRequestHandler("tools/list", async (_request, ctx) => {
    const { tools, missing } = resolveMockTools(
      definition,
      await real.listTools({ signal: ctx.mcpReq.signal })
    );
    if (missing.length > 0) throw editedToolMissingError(missing);
    return { tools };
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const plan = planToolCall(
      definition,
      request.params.name,
      request.params.arguments
    );
    if (!plan) throw toolNotFoundError(request.params.name);
    const relay = relayDuringCall(
      real,
      request.params._meta?.progressToken,
      ctx
    );
    const result = await real
      .callTool({
        name: plan.realName,
        arguments: plan.arguments,
        signal: ctx.mcpReq.signal,
        logLevel: callerLogLevel(ctx),
        onProgress: relay.onProgress,
        onLog: relay.onLog,
      })
      .finally(relay.stop);
    await relay.flush();
    return result;
  });

  // Every other method goes to the real server when both sides have it, and is
  // refused by name when only one does.
  server.fallbackRequestHandler = async (request, ctx) => {
    const family = METHOD_FAMILIES.find(([prefix]) =>
      request.method.startsWith(prefix)
    );
    if (family) {
      const [, capability] = family;
      if (!mockCapabilities[capability])
        throw methodUnavailableError(request.method, "mock", capability);
      if (!info.capabilities[capability])
        throw methodUnavailableError(request.method, "real", capability);
    }
    return real.request(
      { method: request.method, params: request.params },
      { signal: ctx.mcpReq.signal }
    );
  };
  return server;
}

/**
 * Builds a mock server: a real MCP server (served by `@modelcontextprotocol/server`
 * for the 2025 revisions and 2026-07-28) that lists the real server's tools
 * with the definition merged in and sends each call to the same real tool.
 *
 * The result is `createMcpHandler`'s handler: call `handler.fetch(request)`
 * with a web `Request` to get a `Response`. Build one per caller, because
 * `real` is that caller's connection. Without `real`, the mock has no tools.
 */
export function buildMock(
  definition: MockDefinition,
  real: MockRealServer = NO_REAL_SERVER
): McpHttpHandler {
  return createMcpHandler(
    (ctx) => buildServer(definition, real, ctx.requestInfo?.signal),
    { legacy: "stateless" }
  );
}
