import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import type {
  McpHttpHandler,
  Result,
  ServerContext,
  ServerCapabilities,
  ServerEventBus,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import { definitionHasStep, definitionRunsTasks } from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import { definitionCompletes } from "./completions.js";
import { MockServer } from "./mock-server.js";
import { answerTaskMethod, TASKS_EXTENSION_ID } from "./mock-tasks.js";
import type { MockTasks } from "./mock-tasks.js";
import { notifierFor } from "./notifier.js";
import {
  listLegacyTasks,
  registerCompletionHandler,
  registerSubscribeHandlers,
  registerTaskExtensionHandlers,
  taskNotHeld,
} from "./protocol-handlers.js";
import {
  capabilitiesForRevision,
  MODERN_REVISION,
  revisionOf,
} from "./revision.js";
import type { MockRecords } from "./record-store.js";
import type { MockObserver } from "./mock-observer.js";
import {
  methodUnavailableError,
  unknownMethodError,
  isRealUnreachable,
  realUnreachableError,
} from "./mock-errors.js";
import { forRevision } from "./legacy-result.js";
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

/** Methods a revision dropped; the server SDK or the real server must not see them from a caller on that revision. */
const DROPPED_IN_MODERN = [
  "logging/setLevel",
  "resources/subscribe",
  "resources/unsubscribe",
  "tasks/list",
  "tasks/result",
  "ping",
];
const ONLY_IN_MODERN = ["subscriptions/listen", "server/discover"];

/**
 * The real server's capabilities with the definition's laid over them; `null`
 * removes one. A family is declared only when the real server has it or the
 * definition adds to it, so a mock of a resource-only server stays tool-less
 * and a mock with no prompts advertises none.
 */
function effectiveCapabilities(
  real: ServerCapabilities,
  definition: MockDefinition,
  revision: string,
  tasks: MockTasks | undefined
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
  const modern = revision === MODERN_REVISION;
  // `extensions` is a 2026-07-28 field: the mock adds to it only there.
  if (
    modern &&
    definitionServesSkills(definition) &&
    !("extensions" in stated)
  ) {
    merged.extensions = { ...skillsCapability(), ...(real.extensions ?? {}) };
  }
  // A case that logs makes the mock a server that logs; one that announces a
  // change makes it a server that announces it.
  const has = (kind: string) =>
    definitionHasStep(definition, (step) => step.kind === kind);
  if (has("log") && !("logging" in stated)) merged.logging ??= {};
  for (const list of ["tools", "prompts", "resources"] as const) {
    if (
      definitionHasStep(
        definition,
        (step) => step.kind === "listChanged" && step.list === list
      ) &&
      !(list in stated)
    ) {
      merged[list] = {
        ...(merged[list] as object | undefined),
        listChanged: true,
      };
    }
  }
  if (has("resourceUpdated") && !("resources" in stated)) {
    merged.resources = {
      ...(merged.resources as object | undefined),
      subscribe: true,
    };
  }
  if (definitionCompletes(definition) && !("completions" in stated)) {
    merged.completions ??= {};
  }
  // A case that runs as a task makes the mock a task server, on the wire the
  // caller's revision speaks: the 2025-11-25 utility or the 2026-07-28 extension.
  if (tasks && definitionRunsTasks(definition)) {
    if (modern && !("extensions" in stated)) {
      merged.extensions = {
        ...(merged.extensions as object | undefined),
        [TASKS_EXTENSION_ID]: {},
      };
    } else if (revision === "2025-11-25" && !("tasks" in stated)) {
      // Merged into what the real server states, which may name only some of
      // these: a client checks `cancel` and `requests.tools.call` before it
      // cancels or starts a task.
      const inherited = (merged.tasks ?? {}) as Record<string, unknown>;
      const requests = (inherited.requests ?? {}) as Record<string, unknown>;
      const tools = (requests.tools ?? {}) as Record<string, unknown>;
      // A list names every task `tasks/get` can read, so the mock offers one
      // only when it can name the real server's tasks too: a real server that
      // runs tasks but cannot list them leaves the mock with no list.
      const lists = merged.tasks === undefined || inherited.list !== undefined;
      merged.tasks = {
        ...inherited,
        ...(lists && { list: inherited.list ?? {} }),
        cancel: inherited.cancel ?? {},
        requests: { ...requests, tools: { ...tools, call: tools.call ?? {} } },
      };
    }
  }
  return capabilitiesForRevision(merged as ServerCapabilities, revision);
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
  /**
   * Where the tasks of `task` cases live, and whose they are. Without it such
   * a case answers in place and the mock declares no tasks. The host supplies
   * the store (the backend's, so any replica polls a task) and the owner.
   */
  tasks?: MockTasks;
  /**
   * Where the records of tools that declare `state` live, and which copy this
   * request works on (the saved version's, or a run's at its epoch). Without
   * it such a tool answers with an error naming the missing records.
   */
  records?: MockRecords;
  /**
   * Where 2026-07-28 change notifications go (`subscriptions/listen` streams
   * subscribe to it). Share one across the requests of a caller so a stream
   * open on one request hears a change a call on another raised; left out,
   * each handler has its own.
   */
  bus?: ServerEventBus;
}

async function buildServer(
  definition: MockDefinition,
  real: MockRealServer,
  options: BuildMockOptions,
  era: "legacy" | "modern",
  bus: () => ServerNotifier,
  request?: Request
): Promise<Server> {
  const signal = request?.signal;
  const revision = await revisionOf(era, request);
  let info: MockRealServerInfo;
  try {
    info = await real.describe({ signal });
  } catch (cause) {
    // A factory that throws is masked as a generic internal error, so serve a
    // server that answers every request with the reason instead.
    return unreachableServer(realUnreachableError(cause));
  }
  const mockCapabilities = effectiveCapabilities(
    info.capabilities,
    definition,
    revision,
    options.tasks
  );
  const instructions = definition.instructions ?? info.instructions;
  const server = new MockServer(
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
  // Tasks run only when the host gave a store and this revision declares them.
  const tasks = (
    revision === MODERN_REVISION
      ? Boolean(mockCapabilities.extensions?.[TASKS_EXTENSION_ID])
      : Boolean(mockCapabilities.tasks)
  )
    ? options.tasks
    : undefined;
  const context = {
    definition,
    real,
    observer: options.observer,
    revision,
    notifierFor: (ctx?: ServerContext) => notifierFor(era, bus, ctx),
    tasks,
    records: options.records,
  };
  if (mockCapabilities.tools) registerToolHandlers(server, context);
  const itemContext = {
    definition,
    real,
    realCapabilities: info.capabilities,
    mockCapabilities,
    revision,
  };
  registerItemHandlers(server, itemContext);
  if (mockCapabilities.completions)
    registerCompletionHandler(server, itemContext);
  if (revision !== MODERN_REVISION && mockCapabilities.resources?.subscribe) {
    registerSubscribeHandlers(server, itemContext);
  }
  if (tasks && revision === MODERN_REVISION) {
    registerTaskExtensionHandlers(server, itemContext, tasks);
  }

  // Every other method goes to the real server when both sides have it, and is
  // refused by name when only one does. The host decides each forward first.
  server.fallbackRequestHandler = async (request, ctx) => {
    // A method the caller's revision lacks is not found, whatever the real server speaks.
    const modern = revision === MODERN_REVISION;
    if (
      (modern && DROPPED_IN_MODERN.includes(request.method)) ||
      (!modern && ONLY_IN_MODERN.includes(request.method))
    ) {
      throw unknownMethodError(request.method);
    }
    if (tasks && !modern && request.method.startsWith("tasks/")) {
      if (request.method === "tasks/list") {
        return (await listLegacyTasks(
          tasks,
          itemContext,
          request.params,
          ctx.mcpReq.signal
        )) as Result;
      }
      const answered = await answerTaskMethod(
        tasks,
        "legacy",
        request.method,
        request.params,
        ctx.mcpReq.signal
      );
      if (answered) return answered as Result;
      return (await taskNotHeld(
        itemContext,
        request.method,
        request.params,
        ctx.mcpReq.signal
      )) as Result;
    }
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
    if (
      request.method.startsWith("resources/") &&
      /subscribe$/i.test(request.method) &&
      !mockCapabilities.resources?.subscribe
    ) {
      throw methodUnavailableError(
        request.method,
        "mock",
        "resource subscriptions"
      );
    }
    await assertRequestForward(context, request.method, ctx.mcpReq.signal);
    try {
      return forRevision(
        await real.request(
          { method: request.method, params: request.params },
          { signal: ctx.mcpReq.signal }
        ),
        revision
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
  // The factory runs once per request, after the handler exists; the handler
  // owns the bus the `subscriptions/listen` streams read.
  const handler: McpHttpHandler = createMcpHandler(
    (ctx: { era: "legacy" | "modern"; requestInfo?: Request }) =>
      buildServer(
        definition,
        real,
        options,
        ctx.era,
        () => handler.notify,
        ctx.requestInfo
      ),
    { legacy: "stateless", ...(options.bus && { bus: options.bus }) }
  );
  return handler;
}
