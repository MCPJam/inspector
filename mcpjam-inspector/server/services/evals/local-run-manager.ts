/**
 * The manager a local eval run executes on: its own, authorized by the backend
 * for the run's project servers when it starts, with the accounts chosen for
 * the suite or else the default. A run never borrows this app's UI connection
 * to a project server, two runs on different accounts never share one, and a
 * withdrawn, missing, removed or needs-reconnect account stops the run when it
 * starts (`accountSetGroup`).
 *
 * An environment can also bind servers to this computer by name. A name that
 * is a project server's means that server, authorized like the rest. Any other
 * name is a server only this app has: the run connects it again on its own
 * manager with this app's settings for it. A run with only such servers, or a
 * suite in no project, keeps this app's connections, since the backend has
 * nothing there to authorize.
 */
import type { Context } from "hono";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { HOSTED_MODE, WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  callerContextFromHono,
  createAuthorizedManager,
} from "../../routes/web/auth.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { xaaPolicyFromMcpProfile } from "../../utils/effective-auth.js";
import { anyUnattendedLocalHarness } from "../../utils/harness/local/run-resources.js";
import { logger } from "../../utils/logger.js";
import {
  EVAL_LAUNCH_SERVER_SOURCE,
  environmentServerIds,
  environmentServerNames,
  resolveEnvironmentForLaunch,
  translateEnvironmentResolveError,
  type ResolvedEnvironmentForLaunch,
} from "../environments/resolve.js";
import { hostManagerArgs } from "../events/host-connection.js";
import { resolveXaaIssuer } from "../xaa-mint.js";
import { loadSuiteHostConfig } from "./compat-runtime.js";
import {
  connectReplayManagerServers,
  createConvexClient,
  type ReplayConfig,
} from "./route-helpers.js";
import type { ExecuteSuiteReplayFromRunParams } from "./replay-suite-run.js";
import {
  loadEvalRunAccountPlan,
  loadSuiteConnectionIdSets,
  openEvalAccountGroups,
  type QuickRunAccounts,
  type EvalAccountPlan,
  type EvalAccountSelection,
} from "./suite-account-choices.js";
import type { ConnectionIdSets } from "../../utils/oauth-account-sets.js";

type ProjectServer = { _id: string; name: string; url?: string };

const getProjectServers = makeFunctionReference<
  "query",
  { projectId: string },
  ProjectServer[]
>("servers:getProjectServers");
const getTestSuite = makeFunctionReference<
  "query",
  { suiteId: string },
  { projectId?: string } | null
>("testSuites:getTestSuite");
const getTestCase = makeFunctionReference<
  "query",
  { testCaseId: string },
  { projectId?: string; testSuiteId?: string } | null
>("testSuites:getTestCase");

export type LocalEvalRun = {
  manager: MCPClientManager;
  /** The request fields the run executes with, laid over its body. */
  request: {
    serverIds?: string[];
    serverNames?: string[];
    storageServerIds?: string[];
    resolvedEnvironment?: ResolvedEnvironmentForLaunch;
    quickRunAccounts?: QuickRunAccounts;
    evalAccounts?: {
      plan: EvalAccountPlan;
      requested?: EvalAccountSelection[];
      managerForCase: (caseId: string | undefined) => MCPClientManager;
    };
  };
  /** Ends the run's own connections; never throws. */
  close: () => Promise<void>;
};

/**
 * A project server a run names: by id, or by a name exactly one server has
 * (compared exactly first, then ignoring case). More than one is ambiguous.
 */
function projectServersNamed(servers: ProjectServer[], ref: string) {
  const byId = servers.filter((server) => server._id === ref);
  if (byId.length) return byId;
  const exact = servers.filter((server) => server.name === ref);
  return exact.length
    ? exact
    : servers.filter(
        (server) => server.name.toLowerCase() === ref.toLowerCase(),
      );
}

function ambiguousServer(ref: string) {
  return new WebRouteError(
    404,
    ErrorCode.NOT_FOUND,
    `Could not start eval because more than one server in this project is named "${ref}". Rename one of them, then run again.`,
    { serverId: ref },
  );
}

/** A suite names its servers; the backend authorizes them by id. */
async function projectServerRefs(
  convex: Pick<ConvexHttpClient, "query">,
  projectId: string,
  refs: readonly string[],
) {
  const servers = refs.length
    ? await convex.query(getProjectServers, { projectId })
    : [];
  const kept = new Map<string, { ref: string; name: string }>();
  for (const ref of refs) {
    const named = projectServersNamed(servers, ref);
    if (named.length > 1) throw ambiguousServer(ref);
    if (!named.length) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Could not start eval because "${ref}" is not a server in this project. Add it to the project or remove it from the suite.`,
        { serverId: ref },
      );
    }
    if (!kept.has(named[0]._id))
      kept.set(named[0]._id, { ref, name: named[0].name });
  }
  return {
    serverIds: [...kept.keys()],
    serverNames: [...kept.values()].map((server) => server.name),
    refs: [...kept.values()].map((server) => server.ref),
  };
}

/**
 * An environment's servers: its project servers by id, with every name it
 * binds to this computer that is a project server's moved among them, and the
 * names left, which only this app has. `resolved` is the environment the run
 * executes with, naming only those.
 */
async function environmentServers(
  convex: Pick<ConvexHttpClient, "query">,
  projectId: string,
  resolved: ResolvedEnvironmentForLaunch,
) {
  const selection = resolved.environmentRef.serverSelection;
  const names = selection?.mode === "local" ? selection.names : [];
  const projectServers = names.length
    ? await convex.query(getProjectServers, { projectId })
    : [];
  const local: string[] = [];
  const named = new Map<string, string>();
  for (const name of names) {
    const matches = projectServersNamed(projectServers, name);
    if (matches.length > 1) throw ambiguousServer(name);
    if (matches.length) named.set(matches[0]._id, matches[0].name);
    else local.push(name);
  }
  const ids = environmentServerIds(resolved);
  const listed = environmentServerNames(resolved);
  const run: ResolvedEnvironmentForLaunch = named.size
    ? {
        ...resolved,
        servers: [
          ...ids.map((serverId, index) => ({
            serverId,
            name: listed[index] ?? serverId,
          })),
          ...[...named]
            .filter(([serverId]) => !ids.includes(serverId))
            .map(([serverId, name]) => ({ serverId, name })),
        ],
        environmentRef: {
          ...resolved.environmentRef,
          serverSelection: { mode: "local", names: local },
        },
      }
    : resolved;
  return {
    serverIds: environmentServerIds(run),
    serverNames: environmentServerNames(run),
    localNames: local,
    resolved: run,
  };
}

/**
 * The project a run's suite or case belongs to, else the one its request
 * names. A request naming another project is refused: it would run without
 * the saved choices of the suite's own.
 */
async function runProjectId(
  convex: Pick<ConvexHttpClient, "query">,
  target: { projectId?: string; suiteId?: string; testCaseId?: string },
) {
  const row = target.suiteId
    ? await convex.query(getTestSuite, { suiteId: target.suiteId })
    : target.testCaseId
      ? await convex.query(getTestCase, { testCaseId: target.testCaseId })
      : null;
  const owned = typeof row?.projectId === "string" ? row.projectId : undefined;
  if (owned && target.projectId && owned !== target.projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Could not start eval because this suite belongs to a different project. Open it from its own project, then run again.",
      { projectId: target.projectId },
    );
  }
  return owned ?? target.projectId;
}

/** This app's own connections, for servers the backend can't authorize. */
function appConnections(
  c: Context,
  resolved: ResolvedEnvironmentForLaunch | undefined,
): LocalEvalRun {
  return {
    manager: c.mcpClientManager,
    request: resolved ? { resolvedEnvironment: resolved } : {},
    // This app's connections outlive the run.
    close: () => Promise.resolve(),
  };
}

/** Servers only this app has, connected again on the run's own manager. */
async function connectLocalServers(
  app: MCPClientManager,
  run: MCPClientManager,
  names: readonly string[],
) {
  await Promise.all(
    names.map(async (name) => {
      // A name this app lacks fails where the run resolves its servers.
      const config = app.getServerConfig(name);
      if (!config) return;
      await run.connectToServer(name, config).catch((error: unknown) => {
        // Reported where the run lists its tools, like any server that's down.
        logger.debug(
          "[local evals] connecting a server on this computer failed",
          {
            serverId: name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }),
  );
}

/** Authorizes a local eval run's servers for that run alone. */
export async function openLocalEvalRun(
  c: Context,
  target: {
    convexAuthToken: string;
    projectId?: string;
    suiteId?: string;
    /** A quick run names only its case. */
    testCaseId?: string;
    caseIds?: string[];
    runAccounts?: EvalAccountSelection[];
    serverIds?: string[];
    storageServerIds?: string[];
    environmentId?: string;
    namedHostId?: string;
    /** A suite run connects as its suite's host even when it names none. */
    suiteHost?: boolean;
  },
): Promise<LocalEvalRun> {
  const convex = createConvexClient(target.convexAuthToken);
  // Local server references can be names. Read choices by suite or case,
  // then check the plan after resolving canonical server IDs.
  const connectionIdSets = await loadSuiteConnectionIdSets(convex, {
    suiteId: target.suiteId,
    testCaseId: target.testCaseId,
  });
  const projectId = await runProjectId(convex, target);
  let resolved: ResolvedEnvironmentForLaunch | undefined;
  if (target.environmentId && projectId) {
    const local = await anyUnattendedLocalHarness(
      target.convexAuthToken,
      projectId,
    );
    resolved = await resolveEnvironmentForLaunch(convex, {
      serverSource: EVAL_LAUNCH_SERVER_SOURCE,
      ...(local ? { runtimeVenue: "local" as const } : {}),
      projectId,
      environmentId: target.environmentId,
    }).catch((error) => {
      throw translateEnvironmentResolveError(error);
    });
  }
  if (!projectId) {
    // Saved choices name project servers, so none here could honor one.
    if (connectionIdSets || target.runAccounts) {
      throw new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        "This suite has no project for the selected MCP accounts. Clear the account choices, then run again.",
      );
    }
    return appConnections(c, resolved);
  }
  const servers = resolved
    ? { ...(await environmentServers(convex, projectId, resolved)), refs: [] }
    : {
        ...(await projectServerRefs(convex, projectId, target.serverIds ?? [])),
        localNames: [],
        resolved: undefined,
      };
  if (!servers.serverIds.length && servers.localNames.length && !target.runAccounts) {
    return appConnections(c, servers.resolved);
  }
  const hostId = resolved?.hostId ?? target.namedHostId;
  const host =
    hostId || target.suiteHost
      ? await loadSuiteHostConfig(convex, target.suiteId, hostId)
      : undefined;
  const connection = host
    ? hostManagerArgs(host)
    : {
        timeoutMs: WEB_CALL_TIMEOUT_MS,
        clientCapabilities: undefined,
        options: {},
      };
  const openHosted = (connectionIdSets?: ConnectionIdSets) => createAuthorizedManager(
    callerContextFromHono(c),
    target.convexAuthToken,
    projectId,
    servers.serverIds,
    connection.timeoutMs,
    undefined,
    connection.clientCapabilities,
    {
      // An eval has no iteration sandbox and cannot reserve a personal Computer.
      pluginComputerRuntime: false,
      ...(connectionIdSets ? { connectionIdSets } : {}),
      serverNames: servers.serverNames,
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
      ...(host ? { xaaPolicy: xaaPolicyFromMcpProfile(host.mcpProfile) } : {}),
      ...connection.options,
    },
  );
  const open = async (sets?: ConnectionIdSets) => {
    const { manager } = await openHosted(sets);
    try {
      await connectLocalServers(c.mcpClientManager, manager, servers.localNames);
    } catch (error) {
      await manager.disconnectAllServers();
      throw error;
    }
    return manager;
  };
  const suiteId = target.suiteId ?? (target.testCaseId
    ? (await convex.query(getTestCase, { testCaseId: target.testCaseId }))?.testSuiteId
    : undefined);
  const caseIds = target.testCaseId ? [target.testCaseId] : target.caseIds;
  const plan = suiteId && servers.serverIds.length ? await loadEvalRunAccountPlan(convex, {
    suiteId,
    serverIds: servers.serverIds,
    ...(caseIds?.length ? { caseIds } : {}),
    ...(target.runAccounts ? { runAccounts: target.runAccounts } : {}),
  }) : null;
  if (target.runAccounts && !plan) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Run account choices require a saved suite and connected MCP servers.");
  }
  const scopedChoices = connectionIdSets && Object.fromEntries(
    Object.entries(connectionIdSets).filter(([serverId]) => servers.serverIds.includes(serverId)),
  );
  const groups = plan ? await openEvalAccountGroups(plan, open, scopedChoices) : undefined;
  const manager = groups?.first ?? await open(connectionIdSets);
  return {
    manager,
    request: {
      ...(servers.resolved
        ? { resolvedEnvironment: servers.resolved }
        : {
          serverIds: servers.serverIds,
          serverNames: servers.serverNames,
          storageServerIds: target.storageServerIds ?? servers.refs,
        }),
      ...(plan && target.testCaseId ? {
        quickRunAccounts: { plan, serverIds: servers.serverIds, ...(target.runAccounts ? { runAccounts: target.runAccounts } : {}) },
      } : plan && groups ? {
        evalAccounts: { plan, requested: target.runAccounts, managerForCase: groups.forCase },
      } : {}),
    },
    close: () =>
      (groups ? groups.close() : manager.disconnectAllServers()).catch((error: unknown) => {
        logger.warn("[local evals] closing a run's connections failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
  };
}

/** A server URL as compared for a replay: no fragment, no trailing slash. */
function normalizedUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.href;
  } catch {
    // A URL that does not parse matches only another that does not.
    return undefined;
  }
}

/**
 * A local replay's servers: the project's are authorized again for this run
 * with the suite's chosen accounts instead of their stored tokens; any other
 * server keeps its stored config. A project server whose address changed
 * since the run is refused rather than dialed with its stored token.
 * `serverBindings` maps each name the source run used to the id the server
 * runs under now. `undefined` when none is the project's.
 */
export function projectReplayServers(
  c: Context,
  convexAuthToken: string,
): NonNullable<ExecuteSuiteReplayFromRunParams["openReplayServers"]> {
  return async (target) => {
    const { projectId, replayConfig } = target;
    if (!projectId) return undefined;
    const convex = createConvexClient(convexAuthToken);
    const connectionIdSets = await loadSuiteConnectionIdSets(convex, target);
    const projectServers = await convex.query(getProjectServers, { projectId });
    const stored = new Map(replayConfig.servers.map((s) => [s.serverId, s]));
    const runRefs = Array.isArray(target.environment?.servers)
      ? target.environment.servers.filter(
          (s): s is string => typeof s === "string",
        )
      : [];
    const authorized = new Map<string, string>();
    const serverBindings: Array<{
      serverName: string;
      projectServerId: string;
    }> = [];
    const others: ReplayConfig["servers"] = [];
    const bindings = new Map(target.environment?.serverBindings?.map(({ serverName, projectServerId }) => [serverName, projectServerId]));
    const planned = new Set(target.plan?.map(({ serverId }) => serverId));
    for (const ref of new Set([...stored.keys(), ...runRefs, ...planned])) {
      const named = projectServersNamed(projectServers, bindings.get(ref) ?? ref);
      const server = named.length === 1 ? named[0] : undefined;
      const config = stored.get(ref);
      if (!server) {
        if (target.plan && (!config || planned.has(ref) || !!bindings.get(ref))) {
          throw new WebRouteError(409, ErrorCode.CONFLICT, `The replay cannot reconnect ${ref}. Start a new run with the current MCP servers.`);
        }
        if (config) others.push(config);
        continue;
      }
      if (config && normalizedUrl(config.url) !== normalizedUrl(server.url)) {
        throw new WebRouteError(
          409,
          ErrorCode.CONFLICT,
          `${server.name} has moved to a different address since this run was recorded, so the run can't be replayed. Run the suite again to test the new address.`,
          { serverId: server._id },
        );
      }
      authorized.set(server._id, server.name);
      if (ref !== server._id) {
        serverBindings.push({ serverName: ref, projectServerId: server._id });
      }
    }
    if (!authorized.size) return undefined;
    const open = async (connectionIdSets?: ConnectionIdSets) => {
      const { manager } = await createAuthorizedManager(
        callerContextFromHono(c),
        convexAuthToken,
        projectId,
        [...authorized.keys()],
        WEB_CALL_TIMEOUT_MS,
        undefined,
        undefined,
        {
          pluginComputerRuntime: false,
          ...(connectionIdSets ? { connectionIdSets } : {}),
          serverNames: [...authorized.values()],
          xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
        },
      );
      try {
        await connectReplayManagerServers(manager, { ...replayConfig, servers: others });
        return manager;
      } catch (error) {
        await manager.disconnectAllServers();
        throw error;
      }
    };
    const groups = target.plan ? await openEvalAccountGroups(target.plan, open, connectionIdSets) : undefined;
    return {
      manager: groups?.first ?? await open(connectionIdSets),
      serverIds: [...authorized.keys(), ...others.map((s) => s.serverId)],
      serverBindings,
      ...(groups ? { managerForCase: groups.forCase, close: groups.close } : {}),
    };
  };
}
