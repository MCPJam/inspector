import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  McpHttpHandler,
  ServerCapabilities,
} from "@modelcontextprotocol/server";
import { checkToolArgs } from "../conformance-tool-args.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockObserver } from "./mock-observer.js";
import { pageOf } from "./paging.js";
import { answerFromSaved } from "./saved-answers.js";
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

/** What a host can hand `buildMock` besides the definition and the real server. */
export interface BuildMockOptions {
  /** Told about each call the mock answers itself and each call no saved case matched. */
  observer?: MockObserver;
}

/** A refusal a model reads, as a real server's input check gives it. */
function toolErrorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

async function buildServer(
  definition: MockDefinition,
  real: MockRealServer,
  options: BuildMockOptions,
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

  server.setRequestHandler("tools/list", async (request, ctx) => {
    const { tools, missing } = resolveMockTools(
      definition,
      await real.listTools({ signal: ctx.mcpReq.signal })
    );
    if (missing.length > 0) throw editedToolMissingError(missing);
    const page = pageOf(tools, request.params?.cursor, definition.pageSize);
    return {
      tools: page.items,
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const plan = planToolCall(
      definition,
      request.params.name,
      request.params.arguments
    );
    if (!plan) throw toolNotFoundError(request.params.name);
    const entry = definition.tools?.[request.params.name];
    if (entry?.answer?.from === "saved") {
      const realTools = await real.listTools({ signal: ctx.mcpReq.signal });
      const listed = resolveMockTools(definition, realTools).tools.find(
        (tool) => tool.name === request.params.name
      );
      const input = request.params.arguments ?? {};
      const verdict = checkToolArgs(listed?.inputSchema, input);
      const tool = request.params.name;
      if (verdict.verdict === "invalid") {
        options.observer?.({
          type: "answered",
          tool,
          source: "saved",
          outcome: "invalid_input",
        });
        return toolErrorResult(
          `Input validation error: invalid arguments for tool ${tool}: ${verdict.message}. Fix the arguments and call it again.`
        );
      }
      const outcome = answerFromSaved(entry.answer, input);
      if (outcome.kind === "answered") {
        options.observer?.({
          type: "answered",
          tool,
          source: "saved",
          caseIndex: outcome.caseIndex,
          outcome: "case",
        });
        return outcome.result;
      }
      options.observer?.({ type: "unmatched", tool, arguments: input });
      // A tool the real server also has falls through to it; an added tool has
      // nothing to fall to, so it says which input found no answer.
      if (!realTools.some((candidate) => candidate.name === plan.realName)) {
        options.observer?.({
          type: "answered",
          tool,
          source: "saved",
          outcome: "no_match",
        });
        return toolErrorResult(
          `No saved answer for ${tool} matches ${JSON.stringify(input)}. Add a case whose "when" fits this input.`
        );
      }
    }
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
  real: MockRealServer = NO_REAL_SERVER,
  options: BuildMockOptions = {}
): McpHttpHandler {
  return createMcpHandler(
    (ctx) => buildServer(definition, real, options, ctx.requestInfo?.signal),
    { legacy: "stateless" }
  );
}
