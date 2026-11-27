import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import type {
  McpHttpHandler,
  Result,
  ServerCapabilities,
} from "@modelcontextprotocol/server";
import type { MockDefinition } from "./definition-types.js";
import type { MockObserver } from "./mock-observer.js";
import {
  methodUnavailableError,
  unknownMethodError,
  isRealUnreachable,
  realUnreachableError,
} from "./mock-errors.js";
import { NO_REAL_SERVER } from "./real-server.js";
import type {
  MockListingFamily,
  MockRealServer,
  MockRealServerInfo,
} from "./real-server.js";
import { answerSkillsMethod, registerItemHandlers } from "./item-handlers.js";
import { definitionServesSkills, skillsCapability } from "./mock-skills.js";
import { ownsItems } from "./resolve-items.js";
import { assertRequestForward, registerToolHandlers } from "./tool-handlers.js";

/** Which capability each family of methods needs; other methods pass to the real server as they are. */
const METHOD_FAMILIES: Array<
  [prefix: string, capability: keyof ServerCapabilities]
> = [
  ["tools/", "tools"],
  ["resources/", "resources"],
  ["prompts/", "prompts"],
  ["completion/", "completions"],
  ["tasks/", "tasks"],
  ["logging/", "logging"],
];

/**
 * The real server's capabilities with the definition's laid over them; `null`
 * removes one. A family is declared only when the real server has it or the
 * definition adds to it, so a mock of a resource-only server stays tool-less
 * and a mock with no prompts advertises none.
 */
function effectiveCapabilities(
  real: ServerCapabilities,
  definition: MockDefinition
): ServerCapabilities {
  const merged: Record<string, unknown> = { ...real };
  const stated = definition.capabilities ?? {};
  for (const [key, value] of Object.entries(stated)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  if (Object.keys(definition.tools ?? {}).length > 0) merged.tools ??= {};
  // What the definition adds, the mock declares, unless the definition says otherwise.
  const own = ownsItems(definition);
  if (own.prompts && !("prompts" in stated)) merged.prompts ??= {};
  if (own.resources && !("resources" in stated)) merged.resources ??= {};
  if (definitionServesSkills(definition) && !("extensions" in stated)) {
    merged.extensions = { ...skillsCapability(), ...(real.extensions ?? {}) };
  }
  return merged as ServerCapabilities;
}

/** The list methods a pinned listing can answer, by the family and result field. */
const PINNED_LISTS: Record<
  string,
  { family: MockListingFamily; field: string } | undefined
> = {
  "prompts/list": { family: "prompts", field: "prompts" },
  "resources/list": { family: "resources", field: "resources" },
  "resources/templates/list": {
    family: "resourceTemplates",
    field: "resourceTemplates",
  },
};

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
  /** Told about each tool call: where its answer came from, and the real tool of a forward. */
  observer?: MockObserver;
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
  const instructions = definition.instructions ?? info.instructions;
  const server = new Server(
    {
      ...info.serverInfo,
      ...definition.serverInfo,
      name:
        definition.serverInfo?.name ?? info.serverInfo?.name ?? "mcpjam-mock",
      version:
        definition.serverInfo?.version ?? info.serverInfo?.version ?? "1.0.0",
    },
    {
      capabilities: mockCapabilities,
      ...(instructions !== undefined && { instructions }),
    }
  );
  const context = { definition, real, observer: options.observer };
  if (mockCapabilities.tools) registerToolHandlers(server, context);
  const itemContext = {
    definition,
    real,
    realCapabilities: info.capabilities,
    mockCapabilities,
  };
  registerItemHandlers(server, itemContext);

  // Every other method goes to the real server when both sides have it, and is
  // refused by name when only one does. The host decides each forward first.
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
    await assertRequestForward(context, request.method, ctx.mcpReq.signal);
    try {
      return await real.request(
        { method: request.method, params: request.params },
        { signal: ctx.mcpReq.signal }
      );
    } catch (cause) {
      // The base is down: a list the mock does not edit comes from the
      // version's saved listing, as it does while forwarding is blocked.
      const listed = PINNED_LISTS[request.method];
      if (listed && real.pinnedListing && isRealUnreachable(cause)) {
        return {
          [listed.field]: await real.pinnedListing(listed.family),
        } as Result;
      }
      // The MCP client throws a TypeError for a method outside the spec, which
      // the server would answer as -32603. No server has such a method, so say
      // method not found, as the spec asks for an unknown method.
      if (cause instanceof TypeError) throw unknownMethodError(request.method);
      throw cause;
    }
  };
  return server;
}

/**
 * Builds a mock server for one request: a real MCP server (served by
 * `@modelcontextprotocol/server` for the 2025 revisions and 2026-07-28) that
 * lists the real server's tools with the definition merged in. A call goes to
 * a saved answer when one matches, and otherwise to the real tool, if the
 * host allows the forward. The mock keeps no session: each request is served
 * from the definition and the request alone.
 *
 * The result is `createMcpHandler`'s handler: call `handler.fetch(request)`
 * with a web `Request` to get a `Response`. Build one per caller, because
 * `real` is that caller's connection. Without `real`, the mock has no real
 * tools to list or forward to.
 */
export function buildMock(
  definition: MockDefinition,
  real: MockRealServer = NO_REAL_SERVER,
  options: BuildMockOptions = {}
): McpHttpHandler {
  return createMcpHandler(
    (ctx: { requestInfo?: Request }) =>
      buildServer(definition, real, options, ctx.requestInfo?.signal),
    { legacy: "stateless" }
  );
}
