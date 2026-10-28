import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import { resolveChatTurn } from "../../services/chat-turn/resolve-chat-turn.js";
import {
  runtimeServerIds,
  runtimeServerNames,
  runtimeSkills,
} from "../../services/environments/runtime.js";
import { resolveEffectiveCapabilities } from "../../services/environments/effective-capabilities.js";
import { fetchPluginRuntimeAttribution } from "../../services/environments/plugin-attribution.js";
import { assertHostPointerAgreement } from "./chat-session-host-target.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import type { ResolvedEnvironmentRuntime } from "../../services/environments/runtime.js";
import type { EffectiveCapabilitySet } from "../../services/environments/effective-capabilities.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";
import type { ChatSessionHostTarget } from "./chat-session-host-target.js";

export interface ResolvedTarget {
  serverIds: string[];
  serverNames?: string[];
  environmentId?: string;
  resolvedEnvironment?: ResolvedEnvironmentRuntime;
  /** Named environments own their capability set; bare server lists use the live pool. */
  environmentCapabilities?: EffectiveCapabilitySet;
  /** Absence permits the live skill fallback; an explicit empty array does not. */
  environmentSkills?: RuntimeSkill[];
  /** Bare server lists retain the emulated rail and carry no host. */
  host?: ChatSessionHostTarget;
  unappliedCapabilities?: string[];
  unavailableServerIds?: string[];
}

/** v1 reports client built-ins that this surface does not execute. */
export function unappliedBuiltInToolIds(
  runtimeConfig: unknown,
): string[] {
  if (
    !runtimeConfig ||
    typeof runtimeConfig !== "object" ||
    !("builtInToolIds" in runtimeConfig)
  ) return [];
  const ids = runtimeConfig.builtInToolIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
}

const capabilitiesRef = makeFunctionReference<
  "query",
  { projectId: string },
  { chatEnvironmentVersion?: number } | null
>("projects:getProjectCapabilities");

type Target = { environmentId?: string; serverIds?: string[]; hostId?: string };
type Context = { authHeader: string; signal?: AbortSignal };
type LegacyResolver = (
  client: ConvexHttpClient,
  projectId: string,
  input: Target,
  context: Context,
) => Promise<ResolvedTarget>;

/** Negotiate at the authenticated boundary so older deployments retain their supported API. */
export async function resolveChatSessionEnvironment(
  client: ConvexHttpClient,
  projectId: string,
  input: Target,
  context: Context,
  legacy: LegacyResolver,
): Promise<ResolvedTarget> {
  const capabilities = await client.query(capabilitiesRef, { projectId });
  if (capabilities === null)
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found.");
  if (capabilities?.chatEnvironmentVersion !== 1) {
    if (input.serverIds?.length === 0) {
      throw new WebRouteError(
        422,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Explicit empty server selection is not supported by this backend.",
      );
    }
    return legacy(client, projectId, input, context);
  }
  const args: Parameters<typeof resolveChatTurn>[0] = {
    target: input.environmentId
      ? { kind: "environment", environmentId: input.environmentId }
      : input.hostId
        ? { kind: "host", hostId: input.hostId }
        : { kind: "adhoc", projectId },
    access: { kind: "project", projectId },
    client,
    bearer: context.authHeader,
    signal: context.signal,
    selection: input.environmentId
      ? { kind: "environment-default" }
      : input.serverIds !== undefined
        ? { kind: "explicit", serverIds: input.serverIds }
        : { kind: "client-default" },
  };
  let resolved;
  let unavailableServerIds: string[] = [];
  try {
    resolved = await resolveChatTurn(args);
  } catch (error) {
    // Keep immutable API pins resumable after a server disappears. Other
    // validation failures (including unpinned plugin servers) remain fatal.
    if (
      !input.serverIds?.length ||
      !(error instanceof WebRouteError) ||
      error.code !== ErrorCode.VALIDATION_ERROR ||
      !/Server .+ is not an available server in this project\./.test(
        error.message,
      )
    )
      throw error;
    const catalog = await client.query(
      makeFunctionReference<
        "query",
        { projectId: string },
        Array<{ _id: string }>
      >("servers:getProjectServers"),
      { projectId },
    );
    const available = new Set(catalog.map((server) => server._id));
    unavailableServerIds = input.serverIds.filter((id) => !available.has(id));
    if (!unavailableServerIds.length) throw error;
    resolved = await resolveChatTurn({
      ...args,
      selection: {
        kind: "explicit",
        serverIds: input.serverIds.filter((id) => available.has(id)),
      },
    });
  }
  const spec = resolved.environment;
  assertHostPointerAgreement({
    ...(input.hostId ? { requestedHostId: input.hostId } : {}),
    environmentHostId: spec.host.hostId,
    environmentId: spec.environmentRef.environmentId,
  });
  const liveServerIds = runtimeServerIds(spec);
  const serverIds = unavailableServerIds.length
    ? (input.serverIds ?? [])
    : liveServerIds;
  if (!serverIds.length && input.serverIds === undefined)
    throw new WebRouteError(
      422,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      input.environmentId
        ? "That environment resolves to no connectable MCP servers."
        : "That client selects no connectable MCP servers.",
    );
  const liveNames = runtimeServerNames(spec);
  const namesById = new Map(
    liveServerIds.map((id, index) => [id, liveNames[index]]),
  );
  const serverNames = unavailableServerIds.length
    ? serverIds.map((id) => namesById.get(id) ?? id)
    : liveNames;
  const attribution = await fetchPluginRuntimeAttribution(client, {
    projectId,
    pluginVersionIds: (spec.pluginVersions ?? []).map((p) => p.pluginVersionId),
  });
  const unappliedCapabilities = unappliedBuiltInToolIds(spec.host.runtimeConfig);
  return {
    serverIds,
    ...(serverNames.length === serverIds.length ? { serverNames } : {}),
    environmentId: input.environmentId,
    resolvedEnvironment: spec,
    ...(unavailableServerIds.length ? { unavailableServerIds } : {}),
    ...(unappliedCapabilities.length ? { unappliedCapabilities } : {}),
    ...(input.environmentId
      ? {
          environmentCapabilities: resolveEffectiveCapabilities(
            spec,
            attribution,
          ),
        }
      : {}),
    ...(input.environmentId && Array.isArray(spec.skills)
      ? { environmentSkills: runtimeSkills(spec) }
      : {}),
    // Bare server lists retain the emulated API rail and the caller's model policy.
    ...(input.environmentId || input.hostId
      ? {
          host: {
            hostId: spec.host.hostId,
            runtimeConfig: spec.host.runtimeConfig,
            source: input.environmentId
              ? ("environment" as const)
              : ("host" as const),
          },
        }
      : {}),
  };
}
