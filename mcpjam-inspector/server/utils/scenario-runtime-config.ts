/**
 * Fetch the live runtime execution config for a scenario.
 *
 * The chat-v2 endpoints call this when a request carries a `scenarioId` so
 * the server can override client-supplied `model` / `systemPrompt` /
 * `temperature` / `requireToolApproval` with whatever the scenario's host
 * currently resolves to. Without this re-resolution the inspector trusts
 * the client body verbatim — which lets a stale playgroundSession or a
 * tampered request route a scenario session through a different model or
 * skip tool approval. The host's `hostConfigs` row is the source of truth.
 *
 * Backed by `convex/http.ts:/web/scenario/runtime-config`, which in turn
 * walks `scenario → host → hostConfig` via `internalGetScenarioRuntimeConfig`.
 */

import { type Harness } from "@mcpjam/sdk/host-config/internal";
import type { SandboxNoticeReason } from "@/shared/sandbox-notice";
import { logger } from "./logger.js";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import { type RuntimeExecutionFields } from "./execution-scope.js";
import type {
  RuntimeServerSource,
  RuntimeSkillChannel,
} from "../services/environments/runtime.js";

/**
 * Phase 5 (mcpjam-backend PR #805): the additive `environment` payload an
 * ENVIRONMENT-BACKED scenario carries on its runtime config. Present iff the
 * scenario row points at a Project Environment (live-follow) — the backend
 * resolves the environment FRESH on every read and projects its closed server
 * set + composed skill union here. Absent for host-backed scenarios and for
 * backends that predate the field (deploy skew ⇒ legacy behavior).
 *
 * `servers`/`skills` are shaped to structurally satisfy the projections in
 * `services/environments/runtime.ts` (`runtimeServerIds` / `runtimeServerNames`
 * / `runtimeSkills`) and `resolveEffectiveCapabilities`'s
 * `EffectiveCapabilityInput`, so the scenario branch reuses the environment
 * target's helpers instead of growing a second mirror.
 */
export type ScenarioEnvironmentRuntime = {
  environmentRef: {
    environmentId: string;
    name: string;
    revision: number;
  };
  servers: {
    /** The closed set this turn may connect — never the request body's. */
    effectiveServerIds: string[];
    connectable?: Array<{
      serverId: string;
      name: string;
      source?: RuntimeServerSource;
    }>;
  };
  skills?: Array<{
    skillId: string;
    name: string;
    description: string;
    content: string;
    aggregateHash: string;
    extraFrontmatter?: unknown;
    channels?: RuntimeSkillChannel[];
    /**
     * The backend's ready-made provenance row for this entry — opaque here for
     * the reason spelled out on `ResolvedEnvironmentSkill.provenance`: this
     * side only echoes it onto the turn trace, and a typed mirror would be the
     * fourth copy of a shape whose three existing copies all drifted.
     *
     * Passed through TOLERANTLY: any object survives, and a non-object drops.
     * Deliberately NOT routed through the `SKILL_CHANNELS` filter the sibling
     * fields use — that filter exists to keep unknown channels out of delivery
     * decisions, and this field reaches no delivery decision.
     */
    provenance?: Record<string, unknown>;
    files?: Array<{ path: string; size: number; url: string | null }>;
  }>;
  /**
   * Phase 6.1: the environment's pinned plugin versions, mirrored from the
   * resolution the backend already performed for this payload. Same shape as
   * `ResolvedEnvironmentRuntime.pluginVersions`, so the scenario branch can
   * feed the attribution probe the environment target uses. ABSENT on every
   * backend that predates the field — absence degrades to "no plugin origin
   * reported", never to a guess from `connectable[].source`.
   */
  pluginVersions?: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash?: string;
  }>;
};

export type ScenarioRuntimeConfig = RuntimeExecutionFields & {
  scenarioId: string;
  accessVersion: number;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  // Optional for compatibility with backends that predate SEP-1865
  // visibility filtering on runtime-config.
  respectToolVisibility?: boolean;
  // Client capabilities from the scenario's pinned HostConfigV2 — the
  // HOST-AUTHORITATIVE copy. The request body also carries clientCapabilities,
  // but a share-link visitor controls that body; trusting it would let anyone
  // turn on capabilities (e.g. elicitation) the published host has off. Use
  // this for any capability decision on a scenario turn. Optional so a backend
  // predating the field returns omitted → capability treated as absent
  // (fail-closed).
  clientCapabilities?: Record<string, unknown>;
  hostStyle: string;
  // Host-level opt-in for progressive MCP tool discovery, mirrored from
  // the scenario's pinned HostConfigV2. Optional so a backend older than
  // mcpjam-backend PR #334 (which adds the field) returns omitted →
  // undefined and the inspector falls back to its auto policy.
  progressiveToolDiscovery?: boolean;
  // Host/client policy for MCP tool-result content/resource visibility.
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  // Human-facing rendering policy for MCP tool-returned images.
  // Optional so older backends return omitted → inspector defaults inline.
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  // Built-in tool ids from the pinned HostConfigV2 (e.g. ["web_search"]).
  // Optional so a backend older than mcpjam-backend PR #484 (which adds
  // the field to runtime-config) returns omitted → no built-in tools.
  builtInToolIds?: string[];
  // Host harness selector from the pinned HostConfigV2 (mcpjam-backend serves
  // it on runtime-config). Optional so a backend that predates it returns the
  // field omitted → the synthetic runner stays on the emulated path.
  harness?: Harness;
  // Personal-computer attachment from the pinned HostConfigV2 (Project
  // Computers, mcpjam-backend PR #494). The RESOURCE only — capabilities
  // (e.g. "bash") ride builtInToolIds. The backend OMITS the field for
  // guest actors, so its presence implies a signed-in member session.
  // `toolset` is the legacy pre-split key some backend rows still carry;
  // tolerated and ignored (narrowHostComputer drops it). Optional so older
  // backends return omitted → no computer.
  computer?: {
    kind: "personal";
    toolset?: "bash";
    workdir?: string;
  };
  // Host-level MCP profile envelope from the pinned HostConfigV2 — carries
  // the enterprise-managed authorization policy under
  // `extensions["com.mcpjam/enterprise-managed-auth"]`. Server-authoritative
  // for scenario turns (a share-link body must not add/drop the policy).
  // Optional so a backend that predates the projection returns omitted →
  // policy off (safe: matches pre-feature behavior).
  mcpProfile?: Record<string, unknown>;
  // Phase 5: present iff this scenario is environment-backed (live-follow).
  // Read through `readScenarioEnvironment` — never raw — so a present-but-
  // malformed payload fails the turn instead of silently falling back to the
  // request body's server list.
  environment?: ScenarioEnvironmentRuntime;
  /**
   * Phase 4 (mcpjam-backend PR #827): does this scenario's `bash` run on an
   * EPHEMERAL sandbox booted from the environment's pinned image, rather than
   * on the acting member's personal computer?
   *
   * A discriminated STATE MARKER whose ABSENCE is a third state, not a default:
   *   - `{mode:'ephemeral'}`   — provision a per-conversation box and bind bash
   *                              to it. The personal computer is not consulted.
   *   - `{mode:'unavailable'}` — the environment's image can't boot right now.
   *                              The backend has already dropped `computer`, so
   *                              bash is simply not advertised.
   *   - ABSENT                 — OLD BACKEND, or a scenario whose environment
   *                              pins no image. Keep today's behaviour
   *                              (personal computer). Treating absence as "no
   *                              image" would silently move every scenario back
   *                              onto the personal box on any deploy skew.
   *
   * Never carries a template id or a build id: the image is re-resolved
   * server-side at provision.
   */
  computerSandbox?:
    | { mode: "ephemeral" }
    | { mode: "unavailable"; reason?: string };
};

/**
 * Narrow the untrusted `computerSandbox` value off a runtime config.
 *
 * Returns `null` for absent AND for malformed — both mean "this backend did not
 * tell us anything usable", which is the legacy branch. A malformed marker must
 * NOT be read as `ephemeral` (we'd provision against a policy nobody stated) nor
 * as `unavailable` (we'd silently remove a working shell).
 */
export function readComputerSandboxMode(
  config: unknown
): "ephemeral" | "unavailable" | null {
  const raw = (config as { computerSandbox?: unknown } | null | undefined)
    ?.computerSandbox;
  if (!raw || typeof raw !== "object") return null;
  const mode = (raw as { mode?: unknown }).mode;
  return mode === "ephemeral" || mode === "unavailable" ? mode : null;
}

export interface ScenarioSandboxPlan {
  /**
   * `provision` — reserve the per-conversation box, then bind bash to it.
   * `suppress`  — drop the computer resource for this turn; bash is not
   *               advertised. `suppressReason` says why (the caller picks the
   *               matching log line).
   * `none`      — nothing to do: legacy marker-absent config, or a turn that
   *               never asked for bash.
   */
  action: "provision" | "suppress" | "none";
  suppressReason?:
    | "sandbox_mode_unavailable"
    | "not_a_data_plane"
    | "no_chat_session_id";
  /** Set when the suppression should be narrated to the tester (SSE notice). */
  notice?: SandboxNoticeReason;
}

/**
 * Decide what the scenario turn does about its ephemeral sandbox BEFORE any
 * call that spends money.
 *
 * The load-bearing branch is `not_a_data_plane`: `provisionScenarioSandbox` is
 * bearer-authed and succeeds from ANY inspector, but executing in the box
 * requires this process to hold the E2B credentials (`sandbox-bash` has no
 * remote delegation). Provisioning without them used to strand a BILLABLE box
 * whose every command failed opaquely — so the capability check must come
 * before the reserve, not after.
 *
 * Checked before `no_chat_session_id` on purpose: on a non-data-plane server
 * the missing-session case would otherwise suppress silently, and the tester
 * deserves the explanation either way.
 */
export function planScenarioSandbox(args: {
  mode: "ephemeral" | "unavailable" | null;
  bashRequested: boolean;
  ephemeralCloudAvailable: boolean;
  hasChatSessionId: boolean;
}): ScenarioSandboxPlan {
  if (args.mode === "unavailable") {
    return { action: "suppress", suppressReason: "sandbox_mode_unavailable" };
  }
  if (args.mode !== "ephemeral" || !args.bashRequested) {
    return { action: "none" };
  }
  if (!args.ephemeralCloudAvailable) {
    return {
      action: "suppress",
      suppressReason: "not_a_data_plane",
      notice: "sandbox_unavailable",
    };
  }
  if (!args.hasChatSessionId) {
    return { action: "suppress", suppressReason: "no_chat_session_id" };
  }
  return { action: "provision" };
}

export type ScenarioRuntimeConfigResult =
  | { ok: true; config: ScenarioRuntimeConfig }
  // `code` carries the backend's machine-readable denial reason —
  // SCENARIO_ACCESS_STALE above all, which is the difference between "this
  // caller must re-redeem and retry" and "this caller is out". Callers that
  // only render the message can keep ignoring it.
  | { ok: false; status: number; error: string; code?: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for scenario runtime-config");
  }
  return convexHttpUrl;
}

export async function fetchScenarioRuntimeConfig(args: {
  scenarioId: string;
  bearer: string;
  /**
   * The caller's cached access version. Sending it opts this request into
   * backend version enforcement: a value behind the scenario's current one
   * comes back 409 SCENARIO_ACCESS_STALE instead of being silently served a
   * config the caller no longer has a current view of. Omitted ⇒ unchecked.
   */
  accessVersion?: number;
  signal?: AbortSignal;
}): Promise<ScenarioRuntimeConfigResult> {
  const url = new URL(
    "/web/scenario/runtime-config",
    getConvexHttpUrl()
  ).toString();
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({
        scenarioId: args.scenarioId,
        ...(typeof args.accessVersion === "number"
          ? { accessVersion: args.accessVersion }
          : {}),
      }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[scenario-runtime-config] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach scenario runtime-config endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Scenario runtime-config returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true || !payload?.config) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Scenario runtime-config failed (${response.status})`,
      ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
    };
  }

  return { ok: true, config: payload.config as ScenarioRuntimeConfig };
}

export type ScenarioEnvironmentReadResult =
  | { kind: "absent" }
  | { kind: "present"; environment: ScenarioEnvironmentRuntime }
  | { kind: "invalid"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const SERVER_SOURCES: ReadonlySet<string> = new Set([
  "host_or_group",
  "plugin",
  "override",
]);
const SKILL_CHANNELS: ReadonlySet<string> = new Set([
  "host",
  "environment",
  "plugin",
]);

/**
 * Shape-check the additive `environment` payload on a scenario runtime config.
 *
 * Split fail-closed vs tolerant on the SAME line `assertRuntimeInvariants`
 * (services/environments/runtime.ts) draws for environment targets:
 *
 *   - IDENTITY (`environmentRef.environmentId` + numeric `revision`) and the
 *     CLOSED SERVER SET (`servers.effectiveServerIds`) are invariants. A
 *     payload that is present but missing them is not a degraded environment,
 *     it is an unknown one — `invalid`, and the caller must stop the turn
 *     rather than fall back to the body's server list.
 *   - Everything additive (connectable names/sources, skills, files, channels)
 *     is the deploy-skew surface: unknown enum values are dropped to
 *     `undefined`, malformed entries are dropped, absence means "none".
 *
 * `absent` (field omitted / null) means host-backed scenario or an older
 * backend — the caller keeps today's behavior byte-identical.
 */
export function readScenarioEnvironment(
  config: ScenarioRuntimeConfig
): ScenarioEnvironmentReadResult {
  const raw = (config as { environment?: unknown }).environment;
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (!isRecord(raw)) return { kind: "invalid", detail: "not an object" };

  const ref = raw.environmentRef;
  if (!isRecord(ref) || typeof ref.environmentId !== "string") {
    return { kind: "invalid", detail: "missing environmentRef" };
  }
  if (typeof ref.revision !== "number") {
    return { kind: "invalid", detail: "missing revision" };
  }

  const servers = raw.servers;
  if (!isRecord(servers) || !Array.isArray(servers.effectiveServerIds)) {
    return { kind: "invalid", detail: "missing effective server set" };
  }
  const effectiveServerIds = servers.effectiveServerIds.filter(
    (id): id is string => typeof id === "string"
  );
  if (effectiveServerIds.length !== servers.effectiveServerIds.length) {
    // A torn id list is an unknown server set, not a smaller one.
    return { kind: "invalid", detail: "non-string server id" };
  }

  const connectable = Array.isArray(servers.connectable)
    ? servers.connectable.flatMap((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.serverId !== "string" ||
          typeof entry.name !== "string"
        ) {
          return [];
        }
        const source =
          typeof entry.source === "string" && SERVER_SOURCES.has(entry.source)
            ? (entry.source as RuntimeServerSource)
            : undefined;
        return [
          {
            serverId: entry.serverId,
            name: entry.name,
            ...(source ? { source } : {}),
          },
        ];
      })
    : undefined;

  const skills = Array.isArray(raw.skills)
    ? raw.skills.flatMap((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.skillId !== "string" ||
          typeof entry.name !== "string" ||
          typeof entry.content !== "string" ||
          typeof entry.aggregateHash !== "string"
        ) {
          return [];
        }
        const channels = Array.isArray(entry.channels)
          ? entry.channels.filter(
              (channel): channel is RuntimeSkillChannel =>
                typeof channel === "string" && SKILL_CHANNELS.has(channel)
            )
          : undefined;
        const files = Array.isArray(entry.files)
          ? entry.files.flatMap((file) =>
              isRecord(file) &&
              typeof file.path === "string" &&
              typeof file.size === "number"
                ? [
                    {
                      path: file.path,
                      size: file.size,
                      url: typeof file.url === "string" ? file.url : null,
                    },
                  ]
                : []
            )
          : undefined;
        return [
          {
            skillId: entry.skillId,
            name: entry.name,
            description:
              typeof entry.description === "string" ? entry.description : "",
            content: entry.content,
            aggregateHash: entry.aggregateHash,
            ...(entry.extraFrontmatter !== undefined
              ? { extraFrontmatter: entry.extraFrontmatter }
              : {}),
            ...(channels ? { channels } : {}),
            ...(isRecord(entry.provenance)
              ? { provenance: entry.provenance }
              : {}),
            ...(files ? { files } : {}),
          },
        ];
      })
    : undefined;

  // Additive like `connectable`/`skills`: a malformed entry (or a torn id)
  // drops to nothing — losing a provenance LABEL, never a capability.
  const pluginVersions = Array.isArray(raw.pluginVersions)
    ? raw.pluginVersions.flatMap((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.pluginId !== "string" ||
          typeof entry.pluginVersionId !== "string" ||
          typeof entry.name !== "string"
        ) {
          return [];
        }
        return [
          {
            pluginId: entry.pluginId,
            pluginVersionId: entry.pluginVersionId,
            name: entry.name,
            ...(typeof entry.bundleHash === "string"
              ? { bundleHash: entry.bundleHash }
              : {}),
          },
        ];
      })
    : undefined;

  return {
    kind: "present",
    environment: {
      environmentRef: {
        environmentId: ref.environmentId,
        name: typeof ref.name === "string" ? ref.name : "",
        revision: ref.revision,
      },
      servers: {
        effectiveServerIds,
        ...(connectable ? { connectable } : {}),
      },
      ...(skills ? { skills } : {}),
      ...(pluginVersions ? { pluginVersions } : {}),
    },
  };
}
