import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import type {
  McpHttpHandler,
  ServerCapabilities,
} from "@modelcontextprotocol/server";
import { stepHostFor } from "./case-call.js";
import { definitionLogs } from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockObserver } from "./mock-observer.js";
import { answerSkillsMethod, registerItemHandlers } from "./item-handlers.js";
import { definitionServesSkills, skillsCapability } from "./mock-skills.js";
import { pageOf } from "./paging.js";
import { ownsItems } from "./resolve-items.js";
import type { MockModelAnswerer } from "./model-answers.js";
import { answerItself } from "./self-answer.js";
import {
  editedToolMissingError,
  methodUnavailableError,
  unknownMethodError,
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
  // What the definition adds, the mock declares, unless the definition says otherwise.
  const stated = definition.capabilities ?? {};
  const own = ownsItems(definition);
  if (own.prompts && !("prompts" in stated)) merged.prompts ??= {};
  if (own.resources && !("resources" in stated)) merged.resources ??= {};
  if (definitionServesSkills(definition) && !("extensions" in stated)) {
    merged.extensions = { ...skillsCapability(), ...(real.extensions ?? {}) };
  }
  // A case that logs makes the mock a server that logs.
  if (definitionLogs(definition) && !("logging" in stated))
    merged.logging ??= {};
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
  /** Answers the calls of tools with `answer.from: "model"`; without one, such a call says so. */
  modelAnswerer?: MockModelAnswerer;
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
    const answer = definition.tools?.[request.params.name]?.answer;
    if (answer?.from === "saved" || answer?.from === "model") {
      const realTools = await real.listTools({ signal: ctx.mcpReq.signal });
      const itself = await answerItself({
        tool: resolveMockTools(definition, realTools).tools.find(
          (tool) => tool.name === request.params.name
        ),
        name: request.params.name,
        answer,
        input: request.params.arguments ?? {},
        realHasTool: realTools.some((tool) => tool.name === plan.realName),
        serverName: name,
        serverInstructions: definition.instructions ?? info.instructions,
        observer: options.observer,
        modelAnswerer: options.modelAnswerer,
        signal: ctx.mcpReq.signal,
        caseCall: {
          host: stepHostFor(ctx, request.params._meta?.progressToken),
          responses: ctx.mcpReq.inputResponses,
          requestState: ctx.mcpReq.requestState(),
        },
      });
      if (itself) return itself;
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

  const itemContext = {
    definition,
    real,
    realCapabilities: info.capabilities,
    mockCapabilities,
  };
  registerItemHandlers(server, itemContext);

  // Every other method goes to the real server when both sides have it, and is
  // refused by name when only one does.
  server.fallbackRequestHandler = async (request, ctx) => {
    const skills = await answerSkillsMethod(
      request,
      itemContext,
      ctx.mcpReq.signal
    );
    if (skills) return skills;
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
    try {
      return await real.request(
        { method: request.method, params: request.params },
        { signal: ctx.mcpReq.signal }
      );
    } catch (cause) {
      // The MCP client throws a TypeError for a method outside the spec, which
      // the server would answer as -32603. No server has such a method, so say
      // method not found, as the spec asks for an unknown method.
      if (cause instanceof TypeError)
        throw unknownMethodError(request.method);
      throw cause;
    }
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
