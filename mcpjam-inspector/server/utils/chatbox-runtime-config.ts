/**
 * Fetch the live runtime execution config for a chatbox.
 *
 * The chat-v2 endpoints call this when a request carries a `chatboxId` so
 * the server can override client-supplied `model` / `systemPrompt` /
 * `temperature` / `requireToolApproval` with whatever the chatbox's host
 * currently resolves to. Without this re-resolution the inspector trusts
 * the client body verbatim — which lets a stale playgroundSession or a
 * tampered request route a chatbox session through a different model or
 * skip tool approval. The host's `hostConfigs` row is the source of truth.
 *
 * Backed by `convex/http.ts:/web/chatbox/runtime-config`, which in turn
 * walks `chatbox → host → hostConfig` via `internalGetChatboxRuntimeConfig`.
 */

import { type Harness } from "@mcpjam/sdk/host-config/internal";
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
 * ENVIRONMENT-BACKED chatbox carries on its runtime config. Present iff the
 * chatbox row points at a Project Environment (live-follow) — the backend
 * resolves the environment FRESH on every read and projects its closed server
 * set + composed skill union here. Absent for host-backed chatboxes and for
 * backends that predate the field (deploy skew ⇒ legacy behavior).
 *
 * `servers`/`skills` are shaped to structurally satisfy the projections in
 * `services/environments/runtime.ts` (`runtimeServerIds` / `runtimeServerNames`
 * / `runtimeSkills`) and `resolveEffectiveCapabilities`'s
 * `EffectiveCapabilityInput`, so the chatbox branch reuses the environment
 * target's helpers instead of growing a second mirror.
 */
export type ChatboxEnvironmentRuntime = {
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
    files?: Array<{ path: string; size: number; url: string | null }>;
  }>;
};

export type ChatboxRuntimeConfig = RuntimeExecutionFields & {
  chatboxId: string;
  accessVersion: number;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  // Optional for compatibility with backends that predate SEP-1865
  // visibility filtering on runtime-config.
  respectToolVisibility?: boolean;
  // Client capabilities from the chatbox's pinned HostConfigV2 — the
  // HOST-AUTHORITATIVE copy. The request body also carries clientCapabilities,
  // but a share-link visitor controls that body; trusting it would let anyone
  // turn on capabilities (e.g. elicitation) the published host has off. Use
  // this for any capability decision on a chatbox turn. Optional so a backend
  // predating the field returns omitted → capability treated as absent
  // (fail-closed).
  clientCapabilities?: Record<string, unknown>;
  hostStyle: string;
  // Host-level opt-in for progressive MCP tool discovery, mirrored from
  // the chatbox's pinned HostConfigV2. Optional so a backend older than
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
  // for chatbox turns (a share-link body must not add/drop the policy).
  // Optional so a backend that predates the projection returns omitted →
  // policy off (safe: matches pre-feature behavior).
  mcpProfile?: Record<string, unknown>;
  // Phase 5: present iff this chatbox is environment-backed (live-follow).
  // Read through `readChatboxEnvironment` — never raw — so a present-but-
  // malformed payload fails the turn instead of silently falling back to the
  // request body's server list.
  environment?: ChatboxEnvironmentRuntime;
  /**
   * Phase 4 (mcpjam-backend PR #827): does this chatbox's `bash` run on an
   * EPHEMERAL sandbox booted from the environment's pinned image, rather than
   * on the acting member's personal computer?
   *
   * A discriminated STATE MARKER whose ABSENCE is a third state, not a default:
   *   - `{mode:'ephemeral'}`   — provision a per-conversation box and bind bash
   *                              to it. The personal computer is not consulted.
   *   - `{mode:'unavailable'}` — the environment's image can't boot right now.
   *                              The backend has already dropped `computer`, so
   *                              bash is simply not advertised.
   *   - ABSENT                 — OLD BACKEND, or a chatbox whose environment
   *                              pins no image. Keep today's behaviour
   *                              (personal computer). Treating absence as "no
   *                              image" would silently move every chatbox back
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

export type ChatboxRuntimeConfigResult =
  | { ok: true; config: ChatboxRuntimeConfig }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for chatbox runtime-config");
  }
  return convexHttpUrl;
}

export async function fetchChatboxRuntimeConfig(args: {
  chatboxId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<ChatboxRuntimeConfigResult> {
  const url = new URL(
    "/web/chatbox/runtime-config",
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
      body: JSON.stringify({ chatboxId: args.chatboxId }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[chatbox-runtime-config] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach chatbox runtime-config endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Chatbox runtime-config returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok || payload?.ok !== true || !payload?.config) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Chatbox runtime-config failed (${response.status})`,
    };
  }

  return { ok: true, config: payload.config as ChatboxRuntimeConfig };
}

export type ChatboxEnvironmentReadResult =
  | { kind: "absent" }
  | { kind: "present"; environment: ChatboxEnvironmentRuntime }
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
 * Shape-check the additive `environment` payload on a chatbox runtime config.
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
 * `absent` (field omitted / null) means host-backed chatbox or an older
 * backend — the caller keeps today's behavior byte-identical.
 */
export function readChatboxEnvironment(
  config: ChatboxRuntimeConfig
): ChatboxEnvironmentReadResult {
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
            ...(files ? { files } : {}),
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
    },
  };
}
