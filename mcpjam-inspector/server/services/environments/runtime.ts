/**
 * Project-environment INTERACTIVE runtime resolution (Phase 1.3).
 *
 * The launch sibling is `./resolve.ts` (reproducibility: pin a revision, echo it
 * back, drift-check at run start). This module is the live, per-turn contract:
 * ONE atomic read of `projectEnvironments:resolveEnvironmentForRuntime` that
 * yields everything a turn needs — the host's runtime config through the SAME
 * projection a host-target turn uses, the closed (optionally overridden) server
 * set, the composed three-channel skill union with supporting-file references
 * resolved in the same read, and the pinned plugin versions.
 *
 * Two consumers, deliberately asymmetric:
 *   1. `routes/web/chat-v2.ts` — the full spec, used to actually execute.
 *   2. `routes/web/environments.ts` — a NARROW preview projection for the
 *      browser ({@link toEnvironmentPreview}), which must never carry skill
 *      bodies, signed file URLs, or raw computer/mcpProfile config.
 *
 * Contract discipline, mirroring `resolve.ts`:
 *   - Hand-mirrored, string function ref, `ConvexHttpClient` — no codegen.
 *   - DEPLOY-SKEW TOLERANT for additive fields: anything a newer backend adds
 *     (or an older one omits) is optional here.
 *   - FAIL CLOSED on identity/host invariants. A spec with no `environmentRef`,
 *     no numeric `revision`, or no `host.runtimeConfig` is not a degraded spec —
 *     it is an unknown one, and running a turn on it would misrepresent which
 *     configuration the user launched. Those raise, never default.
 */
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import type { EnvironmentOverrides } from "../../../shared/execution-target.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";

/** Where a connectable server in the resolved set came from. */
export type RuntimeServerSource = "host_or_group" | "plugin" | "override";

/** The channel(s) a resolved skill arrived through. */
export type RuntimeSkillChannel = "host" | "environment" | "plugin";

export interface ResolvedEnvironmentSkill {
  skillId: string;
  name: string;
  description: string;
  content: string;
  /** Folds supporting files; equals the content hash when there are none. */
  aggregateHash: string;
  extraFrontmatter?: unknown;
  /** Optional for deploy skew — an older backend may omit channel provenance. */
  channels?: RuntimeSkillChannel[];
  /** Optional for deploy skew; absent is read as "no supporting files". */
  files?: Array<{ path: string; size: number; url: string | null }>;
}

/**
 * The inspector-side mirror of the backend's `ResolvedEnvironmentRuntimeSpec`.
 *
 * `host.runtimeConfig` is typed as an open record on purpose: it is the same
 * payload `fetchHostRuntimeConfig` returns, and every consumer already reads it
 * through `resolveExecutionContext` (which takes `Record<string, unknown>`).
 * Re-declaring its fields here would create a second, drifting mirror of a
 * contract that already has one.
 */
export interface ResolvedEnvironmentRuntime {
  /** Additive-compatibility DIAGNOSTIC only — never a substitute for the
   *  invariant checks in {@link resolveEnvironmentForRuntime}. */
  specVersion?: number;
  environmentRef: {
    environmentId: string;
    name: string;
    revision: number;
  };
  host: {
    hostId: string;
    hostName?: string;
    hostConfigId?: string;
    runtimeConfig: Record<string, unknown>;
  };
  servers: {
    selectedServerIds?: string[];
    pluginServerIds?: string[];
    baseEffectiveServerIds?: string[];
    effectiveServerIds: string[];
    connectable?: Array<{
      serverId: string;
      name: string;
      source?: RuntimeServerSource;
    }>;
  };
  skills?: ResolvedEnvironmentSkill[];
  pluginVersions?: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash?: string;
  }>;
}

const RUNTIME_FUNCTION_REF =
  "projectEnvironments:resolveEnvironmentForRuntime" as const;

/** The structured payload a Convex `ConvexError` carries on `.data`. */
type ConvexErrorData = {
  code?: string;
  message?: string;
  details?: Record<string, string>;
};

function convexErrorData(error: unknown): ConvexErrorData | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as ConvexErrorData;
}

/** `ENV_*` codes that mean "this environment isn't there for you", not
 *  "it exists but can't currently run". */
const RUNTIME_NOT_FOUND_CODES = new Set(["ENV_NOT_FOUND", "ENV_CROSS_PROJECT"]);

/**
 * Map a resolver rejection onto a route error, preserving the backend's
 * machine-readable `code` in `details` so a caller can branch without parsing
 * prose. The `ENV_*` family is a STATE conflict (409): the caller's request was
 * well-formed, the environment simply cannot produce a runnable configuration
 * right now (a pinned plugin was disabled, the host was deleted, a pinned skill
 * became unpinnable).
 */
export function translateEnvironmentRuntimeError(
  error: unknown
): WebRouteError {
  if (error instanceof WebRouteError) return error;
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  const structuredMessage =
    typeof data?.message === "string" ? data.message : undefined;

  if (code && code.startsWith("ENV_")) {
    if (RUNTIME_NOT_FOUND_CODES.has(code)) {
      return new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Environment not found"
      );
    }
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      structuredMessage ?? "This environment cannot run right now.",
      { code, ...(data?.details ?? {}) }
    );
  }
  if (code === "VALIDATION") {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      structuredMessage ?? "Invalid environment request"
    );
  }
  if (code === "FORBIDDEN" || code === "NOT_FOUND") {
    // Never confirm that a project/environment id exists to a non-member.
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment or project not found, or you do not have access to it."
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/could not find public function/i.test(message)) {
    // Deploy-order skew: the Phase 1 backend contract isn't deployed yet.
    // Same guard (and wording shape) as `resolveEnvironmentForLaunch`.
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This deployment cannot run project environments yet. Retry after the backend deploys."
    );
  }
  if (/not found|unauthorized|not a member/i.test(message)) {
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment or project not found, or you do not have access to it."
    );
  }
  return new WebRouteError(
    502,
    ErrorCode.INTERNAL_ERROR,
    "Environment could not be resolved"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fail-closed structural validation.
 *
 * Everything checked here is an INVARIANT, not a field: identity (which
 * environment, at which revision), the host it binds, and the host's execution
 * shape. Missing any of them means we do not know what we would be running, and
 * a turn must not proceed on a guess. Additive fields (skills, plugin versions,
 * connectable names, server provenance) are deliberately NOT checked — those are
 * the deploy-skew surface.
 */
function assertRuntimeInvariants(raw: unknown): ResolvedEnvironmentRuntime {
  const fail = (detail: string): never => {
    throw new WebRouteError(
      502,
      ErrorCode.INTERNAL_ERROR,
      `This environment resolved to an unusable runtime specification (${detail}). The turn was stopped rather than run with an unknown configuration.`
    );
  };
  if (!isRecord(raw)) return fail("empty response");
  const ref = (raw as { environmentRef?: unknown }).environmentRef;
  if (!isRecord(ref) || typeof ref.environmentId !== "string") {
    return fail("missing environmentRef");
  }
  if (typeof ref.revision !== "number") return fail("missing revision");
  const host = (raw as { host?: unknown }).host;
  if (!isRecord(host) || typeof host.hostId !== "string") {
    return fail("missing host identity");
  }
  if (!isRecord(host.runtimeConfig)) return fail("missing host runtime config");
  const servers = (raw as { servers?: unknown }).servers;
  if (!isRecord(servers) || !Array.isArray(servers.effectiveServerIds)) {
    return fail("missing effective server set");
  }
  return raw as unknown as ResolvedEnvironmentRuntime;
}

/**
 * Resolve one environment for a live turn.
 *
 * `overrides.serverIds` is forwarded as `serverOverrideIds` ONLY when present:
 * absent and `[]` are semantically different at the backend (use the
 * environment vs run with no servers) and must stay different on the way in.
 */
export async function resolveEnvironmentForRuntime(
  convexClient: ConvexHttpClient,
  args: {
    projectId: string;
    environmentId: string;
    overrides?: EnvironmentOverrides;
  }
): Promise<ResolvedEnvironmentRuntime> {
  const serverOverrideIds = args.overrides?.serverIds;
  let raw: unknown;
  try {
    raw = await convexClient.query(
      RUNTIME_FUNCTION_REF as any,
      {
        projectId: args.projectId,
        environmentId: args.environmentId,
        ...(serverOverrideIds !== undefined ? { serverOverrideIds } : {}),
      } as any
    );
  } catch (error) {
    throw translateEnvironmentRuntimeError(error);
  }
  return assertRuntimeInvariants(raw);
}

// ── Projections used by the executing caller ────────────────────────────────

/** The server ids to connect this turn (already live-healed by the backend). */
export function runtimeServerIds(spec: ResolvedEnvironmentRuntime): string[] {
  return Array.isArray(spec.servers.connectable)
    ? spec.servers.connectable.map((entry) => entry.serverId)
    : spec.servers.effectiveServerIds;
}

/**
 * Display names aligned by index with {@link runtimeServerIds}. Empty when the
 * backend omits the name-carrying projection (the manager then falls back to
 * showing the server id) — never a partially-aligned array.
 */
export function runtimeServerNames(spec: ResolvedEnvironmentRuntime): string[] {
  return Array.isArray(spec.servers.connectable)
    ? spec.servers.connectable.map((entry) => entry.name)
    : [];
}

/** True when the resolved set is NOT what the environment resolves to on its
 *  own — i.e. a per-turn override was applied. */
export function runtimeServersAreOverridden(
  spec: ResolvedEnvironmentRuntime
): boolean {
  const base = spec.servers.baseEffectiveServerIds;
  if (!Array.isArray(base)) return false;
  const effective = spec.servers.effectiveServerIds;
  if (base.length !== effective.length) return true;
  return base.some((id, index) => id !== effective[index]);
}

/**
 * The environment's skills in the shape the harness/emulated skill machinery
 * already consumes (`CloudSkillRuntimeItem`). Deliberately a projection, not a
 * cast: only the fields the runtime needs cross over, so a future spec field
 * cannot leak into skill delivery by accident.
 */
export function runtimeSkills(
  spec: ResolvedEnvironmentRuntime
): RuntimeSkill[] {
  return (spec.skills ?? []).map((skill) => ({
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    aggregateHash: skill.aggregateHash,
    ...(skill.extraFrontmatter
      ? { extraFrontmatter: skill.extraFrontmatter as never }
      : {}),
  }));
}

// ── Browser preview projection ──────────────────────────────────────────────

/** How this environment's skills would reach the model on a turn. */
export type EnvironmentSkillDelivery =
  | "emulated"
  | "harness"
  /** The resolved harness has no skill channel (Codex today) — the skills exist
   *  but WOULD NOT be delivered. Surfaced rather than shown as delivered. */
  | "unsupported";

export interface EnvironmentPreview {
  specVersion: number | null;
  environment: { environmentId: string; name: string; revision: number };
  host: {
    hostId: string;
    hostName: string | null;
    hostConfigId: string | null;
    modelId: string | null;
    hostStyle: string | null;
    harness: string | null;
  };
  servers: Array<{
    serverId: string;
    name: string;
    source: RuntimeServerSource | null;
  }>;
  skills: Array<{
    skillId: string;
    name: string;
    description: string;
    channels: RuntimeSkillChannel[];
    /** Whether the skill ships supporting files. The files themselves — paths,
     *  sizes, and above all the signed URLs — are NOT part of the preview. */
    hasFiles: boolean;
  }>;
  plugins: Array<{ pluginId: string; pluginVersionId: string; name: string }>;
  capabilities: {
    requireToolApproval: boolean | null;
    respectToolVisibility: boolean | null;
    progressiveToolDiscovery: boolean | null;
    builtInToolIds: string[];
    /** Presence only. The computer's workdir/kind is execution configuration
     *  and never crosses to the browser through this route. */
    hasComputer: boolean;
    serverCount: number;
    skillCount: number;
    skillDelivery: EnvironmentSkillDelivery;
    pluginCount: number;
    serversOverridden: boolean;
  };
}

function readString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * Narrow, read-only projection for the browser.
 *
 * EVERY field is written out explicitly. There is no spread anywhere in this
 * function, and that is the point: adding a field to the runtime spec — a
 * credential, a signed URL, a raw computer config — must be a no-op here. If a
 * new field belongs in the preview, someone has to type it out and think about
 * it.
 *
 * Specifically excluded, permanently: skill `content`, skill `files` (paths,
 * sizes, and the signed `url`s most of all), the host's `computer` block,
 * `mcpProfile` (carries the enterprise auth policy), `harness` broker/proxy
 * settings, and anything under `runtimeConfig` not listed below.
 */
export function toEnvironmentPreview(
  spec: ResolvedEnvironmentRuntime,
  options: { harnessSupportsSkills: (harnessId: string) => boolean }
): EnvironmentPreview {
  const runtimeConfig = spec.host.runtimeConfig;
  const harness = readString(runtimeConfig, "harness");
  const builtInToolIds = Array.isArray(runtimeConfig.builtInToolIds)
    ? runtimeConfig.builtInToolIds.filter(
        (id): id is string => typeof id === "string"
      )
    : [];
  const skills = spec.skills ?? [];
  const skillDelivery: EnvironmentSkillDelivery = !harness
    ? "emulated"
    : options.harnessSupportsSkills(harness)
    ? "harness"
    : "unsupported";

  const connectable = Array.isArray(spec.servers.connectable)
    ? spec.servers.connectable
    : spec.servers.effectiveServerIds.map((serverId) => ({
        serverId,
        name: serverId,
        source: undefined,
      }));

  return {
    specVersion: typeof spec.specVersion === "number" ? spec.specVersion : null,
    environment: {
      environmentId: spec.environmentRef.environmentId,
      name: spec.environmentRef.name,
      revision: spec.environmentRef.revision,
    },
    host: {
      hostId: spec.host.hostId,
      hostName: spec.host.hostName ?? null,
      hostConfigId: spec.host.hostConfigId ?? null,
      modelId: readString(runtimeConfig, "modelId"),
      hostStyle: readString(runtimeConfig, "hostStyle"),
      harness,
    },
    servers: connectable.map((entry) => ({
      serverId: entry.serverId,
      name: entry.name,
      source: entry.source ?? null,
    })),
    skills: skills.map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      channels: Array.isArray(skill.channels) ? skill.channels : [],
      hasFiles: Array.isArray(skill.files) && skill.files.length > 0,
    })),
    plugins: (spec.pluginVersions ?? []).map((plugin) => ({
      pluginId: plugin.pluginId,
      pluginVersionId: plugin.pluginVersionId,
      name: plugin.name,
    })),
    capabilities: {
      requireToolApproval: readBoolean(runtimeConfig, "requireToolApproval"),
      respectToolVisibility: readBoolean(
        runtimeConfig,
        "respectToolVisibility"
      ),
      progressiveToolDiscovery: readBoolean(
        runtimeConfig,
        "progressiveToolDiscovery"
      ),
      builtInToolIds,
      hasComputer: isRecord(runtimeConfig.computer),
      serverCount: connectable.length,
      skillCount: skills.length,
      skillDelivery,
      pluginCount: (spec.pluginVersions ?? []).length,
      serversOverridden: runtimeServersAreOverridden(spec),
    },
  };
}
