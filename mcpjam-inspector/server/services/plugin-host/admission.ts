import { makeFunctionReference } from "convex/server";
import type { PluginWorkspaceDescriptor } from "../../../shared/plugin-workspace.js";
import { createConvexClient } from "../evals/route-helpers.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { timedPluginStep } from "./timing.js";
import type { HostRuntimeConfig } from "../../utils/host-runtime-config.js";
import {
  pluginServerIdentitySchema,
  type PluginServerIdentity,
} from "./bindings.js";

// Server-owned resolver identity, never a browser-supplied capability bit.
const admissionResolvers = new WeakSet<object>();
export function registerPluginAdmissionResolver<
  T extends (...args: never[]) => unknown,
>(resolver: T): T {
  admissionResolvers.add(resolver);
  return resolver;
}
export function pluginResolverIncludesAdmission(resolver: object): boolean {
  return admissionResolvers.has(resolver);
}

/** Exact component identity comes from the backend's reverse index, not browser labels. */
export async function readPluginExecutionContext(options: {
  projectId: string;
  bearer: string;
  expectedActorId: string;
  serverIds: readonly string[];
  hostId?: string;
  signal?: AbortSignal;
}): Promise<{
  serverBindings: ReadonlyMap<string, Readonly<PluginServerIdentity>>;
  hostConfig?: HostRuntimeConfig;
  serverNamesById: Readonly<Record<string, string>>;
}> {
  if (
    !options.projectId?.trim() ||
    !options.bearer?.trim() ||
    !options.expectedActorId?.trim() ||
    !options.serverIds.length ||
    options.serverIds.length > 64 ||
    options.serverIds.some((id) => !id?.trim()) ||
    (options.hostId !== undefined && !options.hostId.trim())
  )
    throw new PluginWorkspaceAdmissionError();
  const ids = [...new Set(options.serverIds)];
  const signal = AbortSignal.any([
    AbortSignal.timeout(WEB_CALL_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (signal.aborted)
    throw new PluginWorkspaceAdmissionError(options.signal?.aborted === true);
  try {
    const raw: unknown = await awaitAdmission(
      createConvexClient(options.bearer).query(ADMISSION_QUERY, {
        projectId: options.projectId,
        serverIds: ids,
        ...(options.hostId ? { hostId: options.hostId } : {}),
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!raw || typeof raw !== "object")
      throw new PluginWorkspaceAdmissionError();
    const reply = raw as Record<string, unknown>;
    if (
      reply.actorId !== options.expectedActorId ||
      reply.projectId !== options.projectId ||
      !Array.isArray(reply.serverBindings) ||
      reply.serverBindings.length !== ids.length
    )
      throw new PluginWorkspaceAdmissionError();
    const bindings = new Map<string, Readonly<PluginServerIdentity>>();
    for (const value of reply.serverBindings) {
      const parsed = pluginServerIdentitySchema.parse(value);
      if (!ids.includes(parsed.serverId) || bindings.has(parsed.serverId))
        throw new PluginWorkspaceAdmissionError();
      bindings.set(parsed.serverId, Object.freeze(parsed));
    }
    if (options.hostId) {
      const host = reply.hostConfig;
      if (
        !host ||
        typeof host !== "object" ||
        Array.isArray(host) ||
        (host as Record<string, unknown>).hostId !== options.hostId
      )
        throw new PluginWorkspaceAdmissionError();
    }
    const serverNamesById: Record<string, string> = Object.create(null);
    if (
      reply.serverNamesById &&
      typeof reply.serverNamesById === "object" &&
      !Array.isArray(reply.serverNamesById)
    ) {
      for (const id of ids) {
        const name = (reply.serverNamesById as Record<string, unknown>)[id];
        if (
          typeof name === "string" &&
          name.trim() &&
          name.length <= 512 &&
          !/[\u0000-\u001f\u007f]/.test(name)
        )
          serverNamesById[id] = name;
      }
    }
    return {
      serverNamesById: Object.freeze(serverNamesById),
      serverBindings: bindings,
      ...(options.hostId
        ? { hostConfig: reply.hostConfig as HostRuntimeConfig }
        : {}),
    };
  } catch {
    throw new PluginWorkspaceAdmissionError(options.signal?.aborted === true);
  }
}

export async function readPluginServerBindings(
  options: Parameters<typeof readPluginExecutionContext>[0],
) {
  return (await readPluginExecutionContext(options)).serverBindings;
}

const ADMISSION_QUERY = makeFunctionReference<"query">(
  "plugins:authorizePluginExtensionExecution",
);
const CLEANUP_IDENTITY_QUERY = makeFunctionReference<"query">(
  "users:getCurrentUser",
);
const READINESS_QUERY = makeFunctionReference<"query">(
  "plugins:getPluginExtensionAccess",
);

/** Readiness chooses the legacy path; it never replaces execution admission. */
export async function readPluginWorkspaceReadiness(options: {
  projectId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!options.projectId?.trim() || !options.bearer?.trim())
    throw new PluginWorkspaceAdmissionError();
  const signal = AbortSignal.any([
    AbortSignal.timeout(WEB_CALL_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (signal.aborted) throw new PluginWorkspaceAdmissionError(true);
  try {
    const reply: unknown = await awaitAdmission(
      createConvexClient(options.bearer).query(READINESS_QUERY, {
        projectId: options.projectId,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (
      !reply ||
      typeof reply !== "object" ||
      typeof (reply as { enabled?: unknown }).enabled !== "boolean"
    )
      throw new PluginWorkspaceAdmissionError();
    return (reply as { enabled: boolean }).enabled;
  } catch {
    throw new PluginWorkspaceAdmissionError(options.signal?.aborted === true);
  }
}

/** Cleanup verifies identity using the existing read, independently of rollout. */
export async function resolvePluginCleanupActor(options: {
  bearer: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (typeof options.bearer !== "string" || !options.bearer.trim()) {
    throw new PluginWorkspaceAdmissionError();
  }
  const deadline = AbortSignal.timeout(WEB_CALL_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  if (signal.aborted) throw new PluginWorkspaceAdmissionError(true);
  try {
    const result: unknown = await awaitAdmission(
      createConvexClient(options.bearer).query(CLEANUP_IDENTITY_QUERY, {}),
      signal,
    );
    if (signal.aborted) throw new PluginWorkspaceAdmissionError(true);
    if (
      !result ||
      typeof result !== "object" ||
      typeof (result as Record<string, unknown>)._id !== "string" ||
      !(result as { _id: string })._id.trim()
    ) {
      throw new PluginWorkspaceAdmissionError();
    }
    return (result as { _id: string })._id;
  } catch {
    throw new PluginWorkspaceAdmissionError(options.signal?.aborted === true);
  }
}

export class PluginWorkspaceAdmissionError extends Error {
  readonly status: 403 | 408;
  readonly code: "PLUGIN_WORKSPACE_DENIED" | "PLUGIN_WORKSPACE_CANCELLED";

  constructor(cancelled = false) {
    super(
      cancelled
        ? "Plugin workspace request cancelled"
        : "Plugin workspace execution is unavailable for this project",
    );
    this.name = "PluginWorkspaceAdmissionError";
    this.status = cancelled ? 408 : 403;
    this.code = cancelled
      ? "PLUGIN_WORKSPACE_CANCELLED"
      : "PLUGIN_WORKSPACE_DENIED";
  }
}

export interface PluginWorkspaceAdmission {
  readonly actorId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** A fresh backend query. A prior successful read is never an execution grant. */
  revalidate(options?: {
    expectedActorId?: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

/** Runtime identity comes from the resolved host, never the workspace label. */
export function assertPluginWorkspaceRuntime(runtime: {
  harness?: string;
  hostPolicy: { hostStyle?: string };
}): void {
  if (
    runtime.harness !== "codex" &&
    (runtime.harness !== undefined ||
      runtime.hostPolicy.hostStyle !== "chatgpt")
  ) {
    throw new PluginWorkspaceAdmissionError();
  }
}

function awaitAdmission<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new PluginWorkspaceAdmissionError(true));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new PluginWorkspaceAdmissionError(true));
    signal.addEventListener("abort", abort, { once: true });
    // Observe both legs even when cancellation wins; a late network rejection
    // must not become an unhandled rejection or authorize a later effect.
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/**
 * Member admission for the request. The backend derives the actor from its
 * verified bearer and checks membership before rollout. The browser namespace
 * is retained only for presentation; no manager/instance authority lives in it.
 */
export async function admitPluginWorkspace(options: {
  descriptor: PluginWorkspaceDescriptor;
  projectId: string | undefined;
  bearer: string;
  signal?: AbortSignal;
}): Promise<PluginWorkspaceAdmission> {
  const { projectId, bearer, descriptor } = options;
  const workspaceId = descriptor.workspaceId;
  if (
    typeof projectId !== "string" ||
    !projectId.trim() ||
    typeof bearer !== "string" ||
    !bearer.trim()
  ) {
    throw new PluginWorkspaceAdmissionError();
  }

  const query = async (signal?: AbortSignal) => {
    const requestSignals = [options.signal, signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );
    if (requestSignals.some((candidate) => candidate.aborted)) {
      throw new PluginWorkspaceAdmissionError(true);
    }
    const deadline = AbortSignal.timeout(WEB_CALL_TIMEOUT_MS);
    const querySignal = AbortSignal.any([...requestSignals, deadline]);
    try {
      const result: unknown = await timedPluginStep("backend-admission", () =>
        awaitAdmission(
          createConvexClient(bearer).query(ADMISSION_QUERY, { projectId }),
          querySignal,
        ),
      );
      if (querySignal.aborted) throw new PluginWorkspaceAdmissionError(true);
      if (
        !result ||
        typeof result !== "object" ||
        (result as Record<string, unknown>).projectId !== projectId ||
        typeof (result as Record<string, unknown>).actorId !== "string" ||
        !(result as { actorId: string }).actorId.trim()
      ) {
        throw new PluginWorkspaceAdmissionError();
      }
      return (result as { actorId: string }).actorId;
    } catch (error) {
      if (requestSignals.some((candidate) => candidate.aborted)) {
        throw new PluginWorkspaceAdmissionError(true);
      }
      if (error instanceof PluginWorkspaceAdmissionError && !deadline.aborted) {
        throw error;
      }
      // Rollout false/unavailable, lost membership, expired auth, backend
      // failure and malformed replies all deny. Never echo backend details.
      throw new PluginWorkspaceAdmissionError();
    }
  };

  const actorId = await query();
  return Object.freeze({
    actorId,
    projectId,
    workspaceId,
    async revalidate(
      next: { expectedActorId?: string; signal?: AbortSignal } = {},
    ) {
      if (
        next.expectedActorId !== undefined &&
        next.expectedActorId !== actorId
      ) {
        throw new PluginWorkspaceAdmissionError();
      }
      if ((await query(next.signal)) !== actorId) {
        throw new PluginWorkspaceAdmissionError();
      }
    },
  });
}
