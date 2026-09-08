/**
 * `POST /api/v1/chat-sessions/messages` — one agent Playground turn.
 *
 * Send a message, get back the assistant's reply PLUS everything a
 * participant in the conversation could not see: which tools the model
 * picked, the arguments it sent, what each server actually returned, how long
 * each call took, and the turn's token usage. Pass the returned `sessionId`
 * back to continue; omit it to start a new session.
 *
 * WHY NOT `/api/web/chat-v2`. That route already runs this loop, and it speaks
 * a streaming AI-SDK UI-message protocol with a Hono `Context` baked through
 * it. De-streaming it would fork the one handler the product's own Playground
 * depends on. Instead this clones the SYNCHRONOUS-JSON packaging that
 * `routes/v1/agent.ts` already proved (wall clock, per-org concurrency,
 * `runUnifiedAssistantTurn` with `streamSink: "none"`) and points it at the
 * caller's project servers with persistence ON.
 *
 * SPEND SAFETY IS THE DESIGN, not a mitigation. A synchronous endpoint that
 * spends money is exposed to the oldest failure in HTTP: the client times out,
 * retries, and pays twice. Three things stop that, in this order:
 *
 *   1. `idempotencyKey` is REQUIRED. Not optional-with-a-fallback like the
 *      agent route's — there is no legacy caller to preserve, and a spend
 *      endpoint that lets you skip the safety is a spend endpoint that will be
 *      called without it.
 *   2. A Convex TURN LEASE is claimed BEFORE any model call. Same key on a
 *      completed turn replays the answer instead of re-running it; a second
 *      concurrent turn on one session is refused rather than interleaved.
 *      Cross-replica by construction, because the hosted plane has no
 *      affinity and an in-process map would be decorative.
 *   3. The version-conflict 409 is the BACKSTOP, not the mechanism. It fires
 *      after the spend, which makes it a damage report; the lease is what
 *      prevents the damage.
 *
 * TOOL EFFECTS ARE A SEPARATE AXIS FROM SPEND. `toolMode` defaults to
 * `read_only`, which advertises only tools the server annotated
 * `readOnlyHint: true`. That hint is server-asserted — a server may mislabel a
 * mutating tool — so this is a policy the host applies, not a guarantee it can
 * verify, and the operation description says so. `auto` advertises everything
 * and may cause real side effects through arbitrary third-party tools.
 *
 * HOST TARGETING SAYS WHICH ENGINE RUNS. A turn may name a saved host — by
 * `hostId`, or implicitly through the environment that pins one — and the
 * server re-fetches that host's authoritative runtime config to decide between
 * MCPJam's emulated engine and a real agent harness. `harness`/`computer` are
 * never read from the request body. When a harness-declaring target cannot run
 * here the turn is REFUSED before it spends, never quietly downgraded, and
 * every response names the engine it ran on. See `chat-session-host-target.ts`
 * for the rules and why each refusal exists. `hostId` is per-turn and cannot
 * be pinned, so a continuation of a host-established session must re-send it —
 * omitting it is `HOST_TARGET_REQUIRED`, never a quiet fall back to emulated.
 *
 * CONFIG IS FIRST-TURN-ONLY. Model, target, system prompt and tool mode pin at
 * session creation and are stored in `resumeConfig`; a continuation that
 * resends any of them is refused with `CONFIG_ON_CONTINUATION` rather than
 * silently repinned. The backend enforces the same thing at the ingest
 * boundary (`preserveAgentResumePins`), which is the actual guarantee — this
 * check is the friendly error.
 */
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelMessage, ToolSet } from "ai";
import {
  MODEL_ID_PREFIX_TO_PROVIDER,
  runtimeChosenModelSentinelName,
} from "@/shared/model-provider";
import { isBedrockModelId, type ModelProvider } from "@/shared/types";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { createManualHostedConnection } from "../web/auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { resolveTurnRuntime } from "../../utils/resolve-turn-runtime.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import { resolveHostModelDefinition } from "../../utils/org-model-config.js";
import {
  persistChatSessionToConvex,
  type AgentTurnToolMode,
  type ResumeConfig,
} from "../../utils/chat-ingestion.js";
import {
  resolveEnvironmentForRuntime,
  runtimeServerIds,
  runtimeServerNames,
  runtimeSkills as environmentRuntimeSkills,
} from "../../services/environments/runtime.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";
import { logger } from "../../utils/logger.js";
import { listCloudRuntimeSkills } from "../../utils/computers/cloud-skill-tools.js";
import {
  buildLiveEffectiveCapabilities,
  resolveEffectiveCapabilities,
  type EffectiveCapabilitySet,
} from "../../services/environments/effective-capabilities.js";
import { fetchPluginRuntimeAttribution } from "../../services/environments/plugin-attribution.js";
import { captureServerEvent } from "../../utils/analytics.js";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import { resolveWebAuthorizedHarnessStrategy } from "../../utils/harness/harness-proxy-strategy.js";
import {
  assertHarnessDispatchable,
  assertHostPointerAgreement,
  engineLabel,
  resolveChatSessionEngine,
  type ChatSessionEngine,
  type ChatSessionHostTarget,
} from "./chat-session-host-target.js";
import { v1Error, v1Resource } from "./envelope.js";
import { readJsonObjectBody } from "./adapter.js";
import {
  chatSessionClient,
  loadResumeHistory,
  resolveScopedSession,
  type SessionRow,
} from "./chat-sessions.js";
import { joinToolCalls } from "./chat-session-payloads.js";

// ── Caps ────────────────────────────────────────────────────────────────────

const MAX_MESSAGE_CHARS = 8_000;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_STEPS_CEILING = 16;
const DEFAULT_MAX_STEPS = 8;
/** Same wall clock as `/v1/projects/:id/agent`, for the same reason. */
const TURN_WALL_CLOCK_MS = 90_000;
/** In-process per-org concurrent-turn cap (same shape as the agent route's). */
const MAX_CONCURRENT_TURNS_PER_ORG = 4;
/** Connect budget for the target's MCP servers, inside the turn wall clock. */
const CONNECT_TIMEOUT_MS = 30_000;
/**
 * Enumeration budget, the peer of {@link CONNECT_TIMEOUT_MS}.
 *
 * Connecting was bounded; listing was not. A server that answers `initialize`
 * and then never answers `tools/list` is not hypothetical — it is how a
 * half-healthy server usually presents — and it left the turn hanging on an
 * unbounded promise. `TURN_WALL_CLOCK_MS` could not save it: that abort signal
 * is never handed to `getTools`, so nothing in-process observed the stall. The
 * request eventually died at the edge proxy instead, which returns a 502 with
 * NO body, so the SDK could only report `Request to … failed (502)` — no code,
 * no message, nothing naming the server that hung.
 *
 * With a budget the same stall becomes this route's own 502, carrying
 * `SERVER_UNREACHABLE` and a message that says what timed out. Sized to match
 * the connect budget, so connect + list still sit well inside the wall clock.
 */
const LIST_TOOLS_TIMEOUT_MS = 30_000;

// ── Request contract ────────────────────────────────────────────────────────

/**
 * Fields that CONFIGURE a session, as opposed to advancing it.
 *
 * Named as a list rather than checked field-by-field so the
 * `CONFIG_ON_CONTINUATION` refusal can NAME what the caller sent — an error
 * that says "you may not send config" without saying which key it saw is an
 * error the caller has to bisect.
 *
 * WHAT IS *NOT* HERE IS THE INTERESTING PART. `allowedServerIds`,
 * `allowedTools`, `maxToolCalls` and `maxSteps` are PER-TURN bounds, accepted
 * on every turn and applied to that turn only.
 *
 * They started out on this list and had to come off, because being here made
 * them worse than useless: a first turn could narrow to two tools, every
 * continuation would be REFUSED for re-sending the narrowing, and the turn
 * would then run against the full set. The restriction silently evaporated on
 * turn two while the API insisted the caller must not restate it.
 *
 * Persisting them instead is not available: the backend's ingest boundary
 * projects `resumeConfig` through an allowlist, and only `modelId`,
 * `toolMode`, `environmentId` and `serverIds` are agent pins. A field added
 * here that the boundary does not carry validates, returns 200, and is
 * dropped — so the honest option is the explicit one. `toolMode` remains the
 * pinned CEILING; these narrow within it, per turn, and the response reports
 * `advertisedToolCount`/`excludedToolCount` so the effective surface is never
 * a guess.
 */
const CONFIG_FIELDS = [
  "modelId",
  "environmentId",
  "serverIds",
  "systemPrompt",
  // Pinned, and it genuinely persists: `temperature` is carried by the ingest
  // boundary's `resumeConfig` projection, so a continuation reloads the
  // session's own value instead of silently reverting to the model default.
  "temperature",
  "toolMode",
] as const;

const turnSchema = z
  .strictObject({
    projectId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    /**
     * A STABLE identity for the triggering intent — not a fresh uuid per HTTP
     * attempt. A per-attempt key deduplicates nothing: the lease would see a
     * new key on the retry and run (and bill) the turn a second time.
     */
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      // Printable ASCII only: the key crosses a Convex arg boundary and is
      // echoed into logs, and a control character there is a correctness
      // problem the caller can fix if we tell them at the boundary.
      .regex(/^[\x20-\x7E]+$/, "idempotencyKey must be printable ASCII"),
    message: z
      .string()
      .min(1)
      .max(MAX_MESSAGE_CHARS)
      // Bytes too — a char-only cap is ~4x bypassable with multibyte text,
      // and this cap is a spend cap.
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES,
        {
          message: `message exceeds ${MAX_MESSAGE_BYTES} bytes`,
        },
      ),
    modelId: z.string().min(1).optional(),
    /**
     * The saved host (client) this turn executes AS — an opaque pointer, and
     * the ONLY way this surface learns which engine to run.
     *
     * The server re-fetches the host's authoritative runtime config by this id
     * and reads `harness` / `computer` from there. Neither is accepted from
     * the body: this is a `strictObject`, so a body carrying `harness` is a
     * 400 rather than a hint the route might honour.
     *
     * DELIBERATELY NOT IN {@link CONFIG_FIELDS}, and therefore not pinned. The
     * backend's ingest boundary projects `resumeConfig` through
     * `AGENT_RESUME_PIN_KEYS`, which does not carry a host — a `hostId` added
     * there would validate, return 200 and be dropped, so pinning it would
     * refuse every continuation for restating a pin that never persisted. It
     * is per-turn for exactly the reason `allowedServerIds` is: re-send it on
     * every turn you want it applied to.
     *
     * A continuation of a HOST-ESTABLISHED session (one that named a host and
     * nothing else) that omits it is REFUSED — `HOST_TARGET_REQUIRED`, before
     * the lease — rather than run on the emulated engine. Not pinnable is not
     * the same as not required, and a per-turn field that silently changes the
     * ENGINE when forgotten is the one shape this surface must not have.
     * Making it durable is a backend change: `AGENT_RESUME_PIN_KEYS` and the
     * ingest projection would both have to carry a host.
     *
     * An ENVIRONMENT target needs none of this: it resolves its own host
     * server-side on every turn, including continuations, because
     * `environmentId` IS a pin.
     */
    hostId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    serverIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    systemPrompt: z.string().max(8_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxSteps: z.number().int().min(1).max(MAX_STEPS_CEILING).optional(),
    toolMode: z.enum(["read_only", "auto"]).optional(),
    allowedServerIds: z.array(z.string().min(1)).max(20).optional(),
    allowedTools: z.array(z.string().min(1)).max(100).optional(),
    maxToolCalls: z.number().int().min(0).max(MAX_STEPS_CEILING).optional(),
  })
  .refine((value) => !(value.environmentId && value.serverIds), {
    message:
      "Pass at most one of environmentId or serverIds — an environment already resolves its own servers.",
  });

type TurnBody = z.infer<typeof turnSchema>;

// ── In-process concurrency ──────────────────────────────────────────────────

const activeTurnsByOrg = new Map<string, number>();

function acquireTurnSlot(key: string): boolean {
  const active = activeTurnsByOrg.get(key) ?? 0;
  if (active >= MAX_CONCURRENT_TURNS_PER_ORG) return false;
  activeTurnsByOrg.set(key, active + 1);
  return true;
}

function releaseTurnSlot(key: string): void {
  const active = activeTurnsByOrg.get(key) ?? 0;
  if (active <= 1) activeTurnsByOrg.delete(key);
  else activeTurnsByOrg.set(key, active - 1);
}

// ── Model resolution ────────────────────────────────────────────────────────

/**
 * Reject a model id whose provider we would have to GUESS.
 *
 * `classifyModelIdProvider` is total: anything it cannot place falls through
 * to `ollama`, which is correct for the Playground (bare ids are how Ollama
 * BYOK models are stored) and wrong for a public API. A caller who sends
 * `"claude-sonnet-5"` means the hosted Anthropic model; resolving that to a
 * local Ollama model the org may not even have configured spends against the
 * wrong rail and answers with the wrong model — silently.
 *
 * So this surface takes only ids whose provider is EXPLICIT: a recognized
 * `<prefix>/` (every hosted catalog id has one), a `custom:<slug>:` org
 * provider, or a Bedrock-shaped id. An Ollama model is still reachable — as
 * `ollama/<model>`, spelled out.
 */
function assertUnambiguousModelId(modelId: string): void {
  const id = modelId.trim();
  // A RUNTIME-CHOSEN SENTINEL is unambiguous and still unrunnable HERE. This
  // route has no harness — the runtime that would pick the model cannot be
  // reached from it — so `cursor/auto` names nothing this surface can execute.
  //
  // Refused at this line, and not one line later, on purpose: everything below
  // is downstream of `claimTurnLease`, which CREATES the `chatSessions` row
  // (`newSession: { projectId }`) before the model is resolved. A turn that
  // dies after the claim leaves a session row whose `modelId` was never
  // written — blank in the sessions list, a session that looks like it ran on
  // nothing. Failing before the claim means no row is minted at all.
  //
  // The sentinel is deliberately NOT rewritten into some real model: the whole
  // point of it is that the model is unknown to MCPJam.
  const sentinelName = runtimeChosenModelSentinelName(id);
  if (sentinelName) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `modelId "${modelId}" (${sentinelName}) is a placeholder for a runtime that chooses its own model on your own account, not a model this API can run. It only has meaning on a host whose harness provides that runtime. Send a real provider-prefixed model id instead.`,
      { reason: "MODEL_NOT_RUNNABLE" },
    );
  }
  if (id.startsWith("custom:") || isBedrockModelId(id)) return;
  const slashIdx = id.indexOf("/");
  if (
    slashIdx > 0 &&
    Object.prototype.hasOwnProperty.call(
      MODEL_ID_PREFIX_TO_PROVIDER,
      id.slice(0, slashIdx),
    )
  ) {
    return;
  }
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `modelId "${modelId}" does not name a provider, so it cannot be resolved unambiguously. Use a provider-prefixed id such as "anthropic/claude-sonnet-5", a "custom:<provider>:<model>" org model, or a Bedrock inference-profile id.`,
    { reason: "MODEL_AMBIGUOUS" },
  );
}

/** The provider half of the public `model` field. */
function providerOf(modelId: string): ModelProvider | "unknown" {
  const slashIdx = modelId.indexOf("/");
  if (slashIdx > 0) {
    const prefix = modelId.slice(0, slashIdx);
    if (
      Object.prototype.hasOwnProperty.call(MODEL_ID_PREFIX_TO_PROVIDER, prefix)
    ) {
      return MODEL_ID_PREFIX_TO_PROVIDER[prefix]!;
    }
  }
  if (modelId.startsWith("custom:")) return "custom";
  if (isBedrockModelId(modelId)) return "bedrock";
  return "unknown";
}

// ── Turn lease ──────────────────────────────────────────────────────────────

type LeaseResult =
  | {
      status: "claimed";
      turnId: string;
      leasedUntil: number;
      sessionId?: string;
    }
  | { status: "in_progress"; retryAfterMs: number }
  | { status: "completed"; turnId: string; sessionId?: string };

async function claimTurnLease(
  client: ConvexHttpClient,
  args: { idempotencyKey: string; sessionId?: string; projectId?: string },
): Promise<LeaseResult> {
  return (await client.mutation(
    "chatSessions:claimTurnLease" as never,
    {
      idempotencyKey: args.idempotencyKey,
      ...(args.sessionId
        ? { sessionId: args.sessionId }
        : { newSession: { projectId: args.projectId } }),
    } as never,
  )) as LeaseResult;
}

/**
 * Drop a lease we claimed but never completed.
 *
 * Called from `finally` on every path that did not persist. Without it a turn
 * that dies between the claim and the ingest — a model error two seconds in —
 * leaves the session locked for the lease's full TTL, and the caller's honest
 * retry with a NEW key is refused as `TURN_IN_PROGRESS` for three minutes.
 * That is a self-inflicted outage on the failure path, which is the path that
 * most needs to stay usable.
 *
 * Best-effort by construction: a failed release is logged, never thrown. The
 * TTL is the backstop, and turning a released-lease hiccup into a 500 would
 * discard a turn's real answer.
 */
async function releaseTurnLease(
  client: ConvexHttpClient,
  turnId: string,
): Promise<void> {
  try {
    await client.mutation(
      "chatSessions:releaseTurnLease" as never,
      {
        turnId,
      } as never,
    );
  } catch (error) {
    logger.warn("[v1/chat-sessions] turn lease release failed", {
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Target resolution ───────────────────────────────────────────────────────

interface ResolvedTarget {
  serverIds: string[];
  serverNames?: string[];
  environmentId?: string;
  /**
   * The environment's own capability set, when the turn named one.
   *
   * An environment DECIDES what runs — which skills, which plugin versions,
   * which captured server skills — and that decision is the whole reason a
   * caller names one. Building a live set from the project pool instead would
   * hand the model every skill the project has, including the ones the
   * environment deliberately left out, drop the plugin skills it attached, and
   * swap its captured server skills for live ones. Absent ⇒ the turn pinned
   * bare `serverIds` and there is no environment decision to honour, so the
   * caller builds a live set instead.
   */
  environmentCapabilities?: EffectiveCapabilitySet;
  /**
   * The SAME environment decision, flattened for the HARNESS engine.
   *
   * `environmentCapabilities` is what the emulated engine consumes; a harness
   * writes skills to disk inside its sandbox and reads only this flat list
   * (`runtimeSkillsOverride` → `selectHarnessSkillSource`). Setting one and
   * not the other is how an environment-backed harness turn ends up running
   * the LIVE project-wide catalog — the environment's decision honoured on one
   * engine and ignored on the other, which is worse than either alone because
   * the two turns look identical from outside.
   *
   * PRESENCE, not length, is the signal: an environment that resolves zero
   * skills delivers zero, and must never fall through to the project pool.
   * Absent ⇒ nobody ANSWERED — no environment was named, or the resolver is
   * old enough not to carry `skills` — and the live fetch is what is correct
   * for an unknown, since only a real answer may speak for the environment.
   */
  environmentSkills?: RuntimeSkill[];
  /**
   * The host this turn executes as, resolved SERVER-SIDE — from the
   * environment's own `spec.host`, or by re-fetching an explicit `hostId`.
   *
   * Absent for a bare `serverIds` turn with no host pointer, which is the
   * pre-existing shape and always runs the emulated engine. Present ⇒ its
   * `runtimeConfig` is the only source of `harness`/`computer` for this turn.
   */
  host?: ChatSessionHostTarget;
  /**
   * Built-in tool ids the target's client advertises that THIS surface does
   * not run — see {@link unappliedBuiltInToolIds}.
   */
  unappliedCapabilities?: string[];
}

/**
 * The client's `builtInToolIds`, which this route deliberately does not apply.
 *
 * Built-in tools (`bash`, `web_search`) are wired in `routes/web/chat-v2.ts`
 * via `resolveHostTools`; nothing in this route reads them, so an environment
 * whose client attaches a computer and asks for `bash` runs here with the MCP
 * server tools alone. That is a real limitation, not an oversight to paper
 * over — the computer-backed shell needs a reserved box and a data plane this
 * synchronous surface does not stand up.
 *
 * What was wrong is that it happened SILENTLY. The write path accepts the
 * capability, the turn drops it, and the caller sees a model that simply never
 * uses the tool it was configured with — indistinguishable from the model
 * choosing not to. Reporting it turns an invisible gap into a named one.
 *
 * Reported, not refused: a client carrying a computer is a perfectly good
 * client for a plain MCP turn, and refusing the turn would break every caller
 * whose client happens to have one attached.
 */
function unappliedBuiltInToolIds(runtimeConfig: unknown): string[] {
  const ids = (runtimeConfig as { builtInToolIds?: unknown } | undefined)
    ?.builtInToolIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * Read the host's OWN server selection, for a turn that named only a host.
 *
 * Server-authoritative by construction: it comes off the fetched runtime
 * config, never the body. A malformed field reads as EMPTY rather than being
 * partially salvaged — connecting a subset of what a host declares would run a
 * configuration nobody chose.
 */
function hostSelectedServerIds(
  runtimeConfig: Record<string, unknown>,
): string[] {
  const ids = runtimeConfig.selectedServerIds;
  if (!Array.isArray(ids)) return [];
  return ids.every((id) => typeof id === "string" && id.length > 0)
    ? (ids as string[])
    : [];
}

/**
 * Re-fetch a host's authoritative runtime config, and FAIL CLOSED.
 *
 * The same fetch and the same fail-closed posture as `routes/web/chat-v2.ts`'s
 * host-bound branch, for the same reason: this config is the only source of
 * `harness`, so falling back to "no host config" would silently run the
 * emulated engine for a host that declares a real runtime — the exact
 * misattribution this whole path exists to prevent.
 */
async function fetchExplicitHostTarget(
  hostId: string,
  context: { authHeader: string; signal?: AbortSignal },
): Promise<ChatSessionHostTarget> {
  const runtime = await fetchHostRuntimeConfig({
    hostId,
    bearer: context.authHeader,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!runtime.ok) {
    logger.warn("[v1/chat-session-turn] host runtime-config fetch failed", {
      hostId,
      status: runtime.status,
      error: runtime.error,
    });
    // A 403 collapses to 404, the rule this module already applies to
    // sessions: refusal and absence must read identically, or the endpoint
    // becomes an existence oracle for hosts the caller cannot see.
    const [status, code] =
      runtime.status >= 500
        ? ([502, ErrorCode.SERVER_UNREACHABLE] as const)
        : runtime.status === 401
        ? ([401, ErrorCode.UNAUTHORIZED] as const)
        : ([404, ErrorCode.NOT_FOUND] as const);
    throw new WebRouteError(
      status,
      code,
      `Couldn't load host "${hostId}", so the turn was stopped rather than run on the wrong engine. ${runtime.error}`,
      { reason: "HOST_UNRESOLVED", hostId },
    );
  }
  return {
    hostId,
    runtimeConfig: runtime.config as unknown as Record<string, unknown>,
    source: "host",
  };
}

/**
 * Resolve which MCP servers this turn talks to, and which host it runs as.
 *
 * The caller names an environment, a list of server IDS, or a host — never raw
 * server CONFIGS. That is the same rule the eval run-start route enforces:
 * accepting configs on a public endpoint would let a caller point our egress
 * at an arbitrary host under their own project's credentials.
 *
 * A `hostId` alongside an environment is an ASSERTION, not a second target:
 * the environment pins its own host, and a pointer naming a different one is
 * refused rather than resolved by precedence.
 */
async function resolveTarget(
  client: ConvexHttpClient,
  projectId: string,
  input: { environmentId?: string; serverIds?: string[]; hostId?: string },
  hostContext: { authHeader: string; signal?: AbortSignal },
): Promise<ResolvedTarget> {
  // Fetched ONCE, before either branch, so a host pointer costs the same round
  // trip whichever way the target names its servers.
  const explicitHost = input.hostId
    ? await fetchExplicitHostTarget(input.hostId, hostContext)
    : undefined;

  if (input.serverIds && input.serverIds.length > 0) {
    return {
      serverIds: input.serverIds,
      ...(explicitHost ? { host: explicitHost } : {}),
      ...(explicitHost
        ? withUnappliedCapabilities(explicitHost.runtimeConfig)
        : {}),
    };
  }
  if (!input.environmentId) {
    if (explicitHost) {
      // Host-only target: the servers are the ones the HOST selected. Reading
      // them here (rather than making the caller restate them) keeps the whole
      // execution shape server-authoritative — the same set the Playground
      // would connect for this host.
      const serverIds = hostSelectedServerIds(explicitHost.runtimeConfig);
      if (serverIds.length === 0) {
        throw new WebRouteError(
          422,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          `Host "${input.hostId}" selects no MCP servers, so there is nothing to connect. Attach servers to the host, or pass environmentId/serverIds alongside it.`,
        );
      }
      return {
        serverIds,
        host: explicitHost,
        ...withUnappliedCapabilities(explicitHost.runtimeConfig),
      };
    }
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A first turn must name its target: pass environmentId, serverIds, or hostId.",
    );
  }
  const spec = await resolveEnvironmentForRuntime(client, {
    projectId,
    environmentId: input.environmentId,
  });
  // The environment already decided which host runs this turn. A contradicting
  // pointer is rejected here — before any connection, any model resolution and
  // any spend — rather than silently preferring one of the two.
  assertHostPointerAgreement({
    ...(input.hostId ? { requestedHostId: input.hostId } : {}),
    environmentHostId: spec.host.hostId,
    environmentId: input.environmentId,
  });
  const serverIds = runtimeServerIds(spec);
  if (serverIds.length === 0) {
    throw new WebRouteError(
      422,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "That environment resolves to no connectable MCP servers.",
    );
  }
  const serverNames = runtimeServerNames(spec);
  const unappliedCapabilities = unappliedBuiltInToolIds(
    spec.host?.runtimeConfig,
  );
  // Attribution is a SECOND read and deliberately cannot fail the turn: the
  // environment already decided what runs, so a probe blip must degrade origin
  // reporting rather than stop a send. Costs nothing when no plugins are
  // pinned. Mirrors `routes/web/chat-v2.ts`, which is the surface this one has
  // to agree with about what an environment means.
  const attribution = await fetchPluginRuntimeAttribution(client, {
    projectId,
    pluginVersionIds: (spec.pluginVersions ?? []).map(
      (plugin) => plugin.pluginVersionId,
    ),
  }).catch(() => null);
  return {
    serverIds,
    ...(serverNames.length === serverIds.length ? { serverNames } : {}),
    environmentId: input.environmentId,
    environmentCapabilities: resolveEffectiveCapabilities(spec, attribution),
    // The same resolution the emulated engine gets, in the shape the HARNESS
    // engine reads. Set only when the resolver actually ANSWERED about skills:
    // `skills` is one of the additive fields `assertRuntimeInvariants` calls
    // the deploy-skew surface, so an older backend omits it entirely. Presence
    // downstream means "the environment resolved these", and `runtimeSkills`
    // maps an absent array to `[]` — so setting it unconditionally would turn
    // "we were not told" into an authoritative "this environment has none" and
    // silently strip a harness turn of every skill it should have had. Absent
    // stays absent (the live fetch, unchanged); `[]` stays `[]`.
    ...(Array.isArray(spec.skills)
      ? { environmentSkills: environmentRuntimeSkills(spec) }
      : {}),
    // The environment's OWN host, resolved by the backend in the same atomic
    // read as its server set. This is what makes a harness environment run its
    // harness on a CONTINUATION too: `environmentId` is a resume pin, so every
    // turn re-resolves the host from scratch and nothing has to be re-sent.
    host: {
      hostId: spec.host.hostId,
      runtimeConfig: spec.host.runtimeConfig,
      source: "environment",
    },
    ...(unappliedCapabilities.length > 0 ? { unappliedCapabilities } : {}),
  };
}

/**
 * The `unappliedCapabilities` field, spread-only-when-present.
 *
 * Extended to the explicit-host path so a `hostId` turn reports the same gap an
 * environment turn already did. It OVER-reports on a harness turn — the harness
 * has its own shell and file tools in its sandbox, so `bash` is not really
 * missing there — and that is the safe direction for an advisory field: naming
 * a capability the turn may in fact have costs a caller a second look, whereas
 * omitting one it genuinely lacks is the silent gap this field exists to close.
 */
function withUnappliedCapabilities(
  runtimeConfig: Record<string, unknown>,
): { unappliedCapabilities?: string[] } {
  const unappliedCapabilities = unappliedBuiltInToolIds(runtimeConfig);
  return unappliedCapabilities.length > 0 ? { unappliedCapabilities } : {};
}

// ── Tool policy ─────────────────────────────────────────────────────────────

/**
 * Turn the caller's tool policy into the exclusion list `prepareChatV2` takes.
 *
 * `prepareChatV2` filters by NAME, so this asks the manager for the live tool
 * list (which carries `annotations`) and computes the complement. Doing it
 * this way rather than post-filtering the prepared `ToolSet` matters: the
 * model must never SEE a tool it is not allowed to call. A tool advertised and
 * then rejected at dispatch still costs prompt tokens, still shapes the
 * model's plan, and still produces a turn that reads as a refusal rather than
 * a capability boundary.
 */
/**
 * `manager.getTools`, but it cannot hang forever.
 *
 * Rejects rather than degrading to "no tools": the caller turns any failure
 * into a 502, and that fail-closed choice is deliberate — a target we cannot
 * enumerate is a target we cannot apply `read_only` to, and answering with an
 * empty exclusion list would advertise everything.
 */
async function listToolsWithinBudget(
  manager: MCPClientManager,
  serverIds: string[],
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      manager.getTools(serverIds),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `the server did not answer tools/list within ${LIST_TOOLS_TIMEOUT_MS}ms`,
            ),
          );
        }, LIST_TOOLS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    // The loser of the race is abandoned, not cancelled — leaving the timer
    // live would hold the event loop open for the rest of the budget on every
    // healthy turn.
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function computeExcludedToolNames(
  manager: MCPClientManager,
  serverIds: string[],
  policy: {
    toolMode: AgentTurnToolMode;
    allowedTools?: string[];
    /** `maxToolCalls: 0` — advertise nothing at all. */
    excludeAll?: true;
  },
): Promise<{ excluded: string[]; advertised: number }> {
  let tools: Array<{ name?: string; annotations?: { readOnlyHint?: unknown } }>;
  try {
    tools = (await listToolsWithinBudget(manager, serverIds)) as typeof tools;
  } catch (error) {
    // A target we cannot enumerate is a target we cannot apply a tool policy
    // to. Failing OPEN here would advertise every tool on a `read_only` turn,
    // which is precisely the outcome the mode exists to prevent.
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      `Could not list the target's tools, so the ${
        policy.toolMode
      } tool policy cannot be applied: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const allowSet = policy.allowedTools
    ? new Set(policy.allowedTools)
    : undefined;
  const excluded: string[] = [];
  let advertised = 0;
  for (const tool of tools) {
    const name = typeof tool?.name === "string" ? tool.name : undefined;
    if (!name) continue;
    if (policy.excludeAll) {
      excluded.push(name);
      continue;
    }
    const readOnly = tool.annotations?.readOnlyHint === true;
    // An UNANNOTATED tool is excluded under `read_only`. The MCP default for
    // an absent `readOnlyHint` is "assume it mutates", and treating silence as
    // consent would make the mode meaningless against exactly the servers
    // least likely to have thought about annotations.
    const blockedByMode = policy.toolMode === "read_only" && !readOnly;
    const blockedByAllowlist = allowSet !== undefined && !allowSet.has(name);
    if (blockedByMode || blockedByAllowlist) excluded.push(name);
    else advertised += 1;
  }
  return { excluded, advertised };
}

/**
 * Narrow a resolved target by `allowedServerIds`, keeping names paired.
 *
 * Extracted because BOTH of its rules were got wrong inline, in ways nothing
 * would have caught: an empty allowlist read as "no filter" (running against
 * every server the caller had just tried to exclude), and ids filtered while
 * the original name array rode along, which relabels every server after the
 * first gap because the connection layer pairs them positionally.
 */
function narrowTarget(
  target: { serverIds: string[]; serverNames?: string[] },
  allowed: string[] | undefined,
): { selected: Array<{ id: string; name?: string }>; names?: string[] } {
  const selected = target.serverIds
    .map((id, index) => ({ id, name: target.serverNames?.[index] }))
    .filter((entry) => allowed === undefined || allowed.includes(entry.id));
  const names = selected.every((entry) => typeof entry.name === "string")
    ? selected.map((entry) => entry.name as string)
    : undefined;
  return { selected, ...(names ? { names } : {}) };
}

/**
 * serverId → user-assigned name, for namespacing SEP-2640 server-skill refs.
 *
 * Keyed by id rather than positional like `narrowTarget`'s `names`, so a
 * half-populated name array cannot misalign anything: an entry with no name is
 * simply absent, and `prepareChatV2` falls back to the server id for it. That
 * fallback is safe but ugly — the id is host-assigned, which is the property
 * that matters (a server must never get to choose the namespace its own skills
 * are addressed under, so `serverInfo.name` is never a candidate) — it just
 * reads as `p176vpy…/run-evals` instead of `mcpjam-staging-skills/run-evals`
 * in the `listSkills` catalog and in the origin banner on loaded skill content,
 * both of which the model and the user see.
 *
 * Returns `undefined` when nothing is labelled, so the call site can keep to
 * the spread-only-when-present convention the rest of the options use.
 */
function serverLabelsFor(
  selected: ReadonlyArray<{ id: string; name?: string }>,
): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  for (const entry of selected) {
    if (typeof entry.name === "string" && entry.name.length > 0) {
      labels[entry.id] = entry.name;
    }
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/** The two equivalent ways a caller says "run this turn with no tools". */
function wantsNoTools(body: {
  maxToolCalls?: number;
  allowedTools?: string[];
}): boolean {
  return body.maxToolCalls === 0 || body.allowedTools?.length === 0;
}

/**
 * Should a claimed lease be handed back when this turn ends?
 *
 * The three-way distinction IS the idempotency guarantee, so it is stated
 * once, here, rather than inlined in a `finally` where the reasoning would be
 * invisible:
 *
 *   - SETTLED — the ingest completed the lease inside its own mutation. There
 *     is nothing to release.
 *   - SPENT (`modelCallStarted`) — the engine was entered, so money may be
 *     gone and tools may have run against the caller's servers. Releasing here
 *     would free the required-and-stable idempotencyKey to claim a fresh lease
 *     and re-run all of it, which is precisely what the lease exists to
 *     prevent. These keep the lease and let the TTL expire it, so a retry
 *     inside the window is refused rather than re-charged.
 *   - NEITHER — the turn died before any model call (bad target, dead server,
 *     unresolvable model). Release: the caller's retry should run, and holding
 *     the session locked for the full TTL would be a self-inflicted outage on
 *     the failure path that most needs to stay usable.
 */
function shouldReleaseLease(state: {
  leaseTurnId: string | undefined;
  leaseSettled: boolean;
  modelCallStarted: boolean;
}): boolean {
  return Boolean(
    state.leaseTurnId && !state.leaseSettled && !state.modelCallStarted,
  );
}

/**
 * Wrap every executable tool so the turn cannot exceed `maxToolCalls`.
 *
 * ENFORCED AT DISPATCH, not by bounding steps. The engine may emit several
 * tool calls in ONE step, so a step budget is an upper bound on round trips
 * and not on calls — a caller who asked for at most two could get five. The
 * counter here is shared across every tool in the set, so the cap is on the
 * TURN's calls rather than per tool.
 *
 * Over the cap the tool RETURNS an error rather than throwing. A throw would
 * surface as an engine failure and lose the turn's answer; a returned error
 * tells the model, in the place it already reads tool failures, that it has
 * spent its budget and should answer with what it has.
 *
 * Entries with no `execute` are passed through untouched: those are
 * client-fulfilled tools the server never dispatches, so there is nothing here
 * to count, and wrapping one would invent an `execute` the engine's
 * no-execute gates depend on being absent.
 */
function capToolCalls(tools: ToolSet, maxToolCalls: number): ToolSet {
  let used = 0;
  const capped: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    const execute = (entry as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      capped[name] = entry;
      continue;
    }
    capped[name] = {
      ...entry,
      execute: async (...args: unknown[]) => {
        if (used >= maxToolCalls) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `This turn's tool-call budget (maxToolCalls: ${maxToolCalls}) is exhausted. Answer with what you already have; do not call more tools.`,
              },
            ],
          };
        }
        // Counted BEFORE awaiting, so concurrent parallel calls in one step
        // cannot all observe the pre-call count and slip past together.
        used += 1;
        return (execute as (...a: unknown[]) => unknown)(...args);
      },
    } as ToolSet[string];
  }
  return capped;
}

// ── The route ───────────────────────────────────────────────────────────────

export function registerChatSessionTurnRoute(router: Hono): void {
  router.post("/chat-sessions/messages", (c) => handleTurn(c));
}

async function handleTurn(c: Context): Promise<Response> {
  // Graceful degradation on OSS/self-hosted installs: the hosted engine, the
  // delegated-token mint and the lease all require the backend wiring.
  if (!process.env.CONVEX_HTTP_URL || !process.env.CONVEX_URL) {
    return v1Error(
      c,
      "FEATURE_NOT_SUPPORTED",
      "Agent Playground turns require a hosted MCPJam deployment.",
    );
  }

  const body = parseWithSchema(turnSchema, await readJsonObjectBody(c));

  const client = await chatSessionClient(c);
  const authHeader = `Bearer ${await getConvexBearerForRequest(c)}`;

  // --- Resolve the session's identity and pinned config --------------------
  let existing: SessionRow | undefined;
  let projectId: string;
  let runtimeChatSessionId: string;
  let priorMessages: ModelMessage[] = [];
  let expectedVersion: number | undefined;
  let pins: {
    modelId: string;
    toolMode: AgentTurnToolMode;
    systemPrompt?: string;
    temperature?: number;
    environmentId?: string;
    serverIds?: string[];
  };

  if (body.sessionId) {
    const sent = CONFIG_FIELDS.filter((field) => body[field] !== undefined);
    if (sent.length > 0) {
      return v1Error(
        c,
        "VALIDATION_ERROR",
        `A continuation cannot change how the session is configured. Remove: ${sent.join(
          ", ",
        )}. Start a new session to use different settings.`,
        { reason: "CONFIG_ON_CONTINUATION", fields: sent },
      );
    }
    existing = await resolveScopedSession(
      client,
      body.sessionId,
      body.projectId,
    );
    // Only sessions this surface created may be continued through it. A
    // human's live Playground session is being written by a browser holding
    // its own version counter; appending to it from an API would interleave
    // two writers on one transcript, and the human would watch a turn they
    // did not send appear in their tab.
    if (existing.origin !== "api") {
      return v1Error(
        c,
        "CONFLICT",
        "This session was not created through the API, so it cannot be continued here. Start a new session instead.",
        { reason: "CONTINUATION_NOT_ALLOWED", origin: existing.origin ?? null },
      );
    }
    const runtimeId = existing.chatSessionId;
    const resume = existing.resumeConfig;
    if (!runtimeId || !resume?.modelId) {
      // An `api` session that lost its pins cannot be continued deterministically
      // — we would have to invent a model. Say so rather than pick one.
      return v1Error(
        c,
        "CONFLICT",
        "This session is missing the configuration pinned at its first turn, so it cannot be continued. Start a new session.",
        { reason: "CONTINUATION_NOT_ALLOWED" },
      );
    }
    projectId = String(existing.projectId ?? "");
    if (!projectId) {
      return v1Error(
        c,
        "CONFLICT",
        "This session is not attached to a project, so it cannot be continued.",
        { reason: "CONTINUATION_NOT_ALLOWED" },
      );
    }
    runtimeChatSessionId = runtimeId;
    expectedVersion = existing.version;
    pins = {
      modelId: resume.modelId,
      toolMode: resume.toolMode ?? "read_only",
      ...(resume.systemPrompt ? { systemPrompt: resume.systemPrompt } : {}),
      ...(typeof resume.temperature === "number"
        ? { temperature: resume.temperature }
        : {}),
      ...(resume.environmentId ? { environmentId: resume.environmentId } : {}),
      ...(resume.serverIds ? { serverIds: resume.serverIds } : {}),
    };
    // A session whose first turn named ONLY a host pinned no target of its
    // own, because `hostId` cannot be pinned: the ingest boundary's
    // `resumeConfig` projection is an allowlist and does not carry it (see the
    // schema's note). So a bare continuation of such a session knows neither
    // the server set NOR — the part that matters — the ENGINE.
    //
    // Refused, not resolved. "No host pointer, therefore emulated" is exactly
    // the silent emulation this whole path exists to remove, and it would be
    // worse on a continuation than on a first turn: the session's earlier
    // turns may have run a real harness, so the transcript would splice two
    // engines together with nothing in it saying where the seam is. The
    // caller re-sends the `hostId` the first turn's response reported, and the
    // host's CURRENT selection is re-resolved from it.
    //
    // SCOPE, and why it is complete rather than partial: this cannot recognise
    // a host-established session that ALSO pinned `serverIds`, because such a
    // continuation is byte-identical to an ordinary `serverIds` one and nothing
    // durable distinguishes them. Refusing every bare `serverIds` continuation
    // to cover it would break the pre-existing shape of this endpoint for
    // callers who never touched a host. So that combination is refused where it
    // is CREATED instead — `resolveChatSessionEngine`'s `surface-unpinnable-host`
    // rule — and a session that reaches this guard therefore either pins a
    // target the caller chose deliberately, or pins nothing and is refused here.
    if (!pins.environmentId && !pins.serverIds && !body.hostId) {
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "This session pinned no target of its own — its first turn named a host, and hostId is per-turn rather than a resume pin. Re-send the same hostId (the first turn's response reported it) so this turn runs on the engine that host declares. The turn was refused rather than run on the emulated engine.",
        { reason: "HOST_TARGET_REQUIRED" },
      );
    }
    priorMessages = (await loadResumeHistory(existing)) as ModelMessage[];
  } else {
    if (!body.projectId) {
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "projectId is required to start a new session.",
      );
    }
    if (!body.modelId) {
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "modelId is required to start a new session.",
      );
    }
    assertUnambiguousModelId(body.modelId);
    projectId = body.projectId;
    runtimeChatSessionId = randomUUID();
    pins = {
      modelId: body.modelId,
      toolMode: body.toolMode ?? "read_only",
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
      ...(body.temperature !== undefined
        ? { temperature: body.temperature }
        : {}),
      ...(body.environmentId ? { environmentId: body.environmentId } : {}),
      ...(body.serverIds ? { serverIds: body.serverIds } : {}),
    };
  }

  // --- Brake before spending ----------------------------------------------
  const orgKey =
    c.get("mcpjamOrganizationId") ??
    c.get("workosUserId") ??
    `project:${projectId}`;
  if (!acquireTurnSlot(orgKey)) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent turns for this organization (max ${MAX_CONCURRENT_TURNS_PER_ORG}).`,
    );
  }

  const startedAt = Date.now();
  let manager: MCPClientManager | undefined;
  let leaseTurnId: string | undefined;
  let leaseSettled = false;
  /**
   * Set the instant before the engine is invoked, and never cleared.
   *
   * It gates the lease RELEASE in the `finally`, and the distinction it draws
   * is the whole idempotency guarantee. Releasing a lease frees its
   * idempotencyKey to claim a fresh one — which is exactly right for a turn
   * that died BEFORE any model call (bad target, dead server, unresolvable
   * model): the caller's retry should run, and holding the session locked for
   * the full TTL would be a self-inflicted outage on the failure path.
   *
   * It is exactly WRONG once the engine has been entered. A turn that timed
   * out or hit an engine error after tool calls already executed has spent
   * money and may have caused side effects on the caller's servers; releasing
   * there would let the required-and-stable idempotencyKey re-run all of it,
   * which is the precise scenario the lease exists to prevent. Those turns
   * keep the lease and let the TTL expire it.
   */
  let modelCallStarted = false;
  const abortController = new AbortController();
  const wallClock = setTimeout(
    () => abortController.abort(),
    TURN_WALL_CLOCK_MS,
  );
  const requestSignal = c.req.raw.signal;
  const onRequestAbort = () => abortController.abort();
  if (requestSignal.aborted) abortController.abort();
  else requestSignal.addEventListener("abort", onRequestAbort, { once: true });

  try {
    // --- The lease. Before ANY model call. --------------------------------
    let lease: LeaseResult;
    try {
      lease = await claimTurnLease(client, {
        idempotencyKey: body.idempotencyKey,
        ...(body.sessionId ? { sessionId: body.sessionId } : { projectId }),
      });
    } catch (error) {
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `Could not claim a turn lease, so the turn was not started: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (lease.status === "in_progress") {
      return v1Error(
        c,
        "CONFLICT",
        "Another turn is already running on this session. Wait for it to finish, then retry.",
        {
          reason: "TURN_IN_PROGRESS",
          retryAfterMs: lease.retryAfterMs,
        },
      );
    }
    if (lease.status === "completed") {
      // The same key already produced a turn. Report the identity of what was
      // recorded and spend nothing: the transcript and trace reads serve the
      // content, and re-running would bill a second time for an answer that
      // already exists.
      return v1Resource(c, {
        sessionId: lease.sessionId ?? body.sessionId ?? null,
        turnId: lease.turnId,
        projectId,
        persisted: { outcome: "duplicate" as const },
        origin: "api" as const,
        replay: true as const,
        message:
          "A turn with this idempotencyKey already completed. Read it with GET /v1/chat-sessions/{sessionId}/trace.",
      });
    }

    leaseTurnId = lease.turnId;

    // --- Target + model ---------------------------------------------------
    const target = await resolveTarget(
      client,
      projectId,
      {
        ...(pins.environmentId ? { environmentId: pins.environmentId } : {}),
        ...(pins.serverIds ? { serverIds: pins.serverIds } : {}),
        // Per-turn, off the BODY on every turn including continuations — it is
        // not a resume pin (see the schema's note on why it cannot be one).
        ...(body.hostId ? { hostId: body.hostId } : {}),
      },
      // The turn's own controller, so a host fetch stops with the turn rather
      // than running on to its own timeout after the caller has gone.
      { authHeader, signal: abortController.signal },
    );
    // A host-only turn deliberately pins NOTHING here. Pinning the resolved
    // server set would look like a convenience and behave like a trap twice
    // over: a bare continuation would then have a target, run the emulated
    // engine and answer 200 for a session established on a harness; and a
    // continuation that DID re-send `hostId` would connect the set the first
    // turn resolved rather than the one the host selects now, so a host edit
    // would be invisible to the session it was made for. The host is the
    // authority on both, and re-resolving it per turn is the only way to keep
    // it one. The continuation guard above is what makes the absence safe.
    // Narrowed as PAIRS. `createManualHostedConnection` pairs ids and names
    // POSITIONALLY (`buildServerNamesById`), so filtering the ids while
    // passing the target's original name array would relabel every server
    // after the first gap — selecting only the second server would give it the
    // first one's name, and an OAuth or connection failure would then name the
    // wrong server to the caller.
    //
    // An EMPTY `allowedServerIds` narrows to nothing rather than meaning
    // "omitted". Treating `[]` as "no filter" would have run the turn against
    // every server in the target — the opposite of what the field says, and
    // unsafe under `toolMode: "auto"`, where it would enable side effects on
    // servers the caller just tried to exclude. `allowedTools: []` already
    // means "none"; these two must not disagree about what an empty allowlist
    // is.
    const allowed = body.allowedServerIds;
    const { selected, names: selectedServerNames } = narrowTarget(
      target,
      allowed,
    );
    if (selected.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        allowed?.length === 0
          ? "allowedServerIds is empty, so no server would be connected. Omit it to use the whole target."
          : "allowedServerIds excluded every server the target resolves to.",
      );
    }
    const selectedServerIds = selected.map((entry) => entry.id);
    // Built from the PAIRS, not from `selectedServerNames`: that array is
    // all-or-nothing on purpose, so one unnamed server would strip the labels
    // off every named one and send the whole turn back to raw ids.
    const serverLabels = serverLabelsFor(selected);

    const modelDefinition = await resolveHostModelDefinition({
      modelId: pins.modelId,
      projectId,
      auth: { authHeader },
    });

    // --- Engine pre-flight ------------------------------------------------
    //
    // BEFORE the connection and before any model call, so a harness host whose
    // runtime is unavailable costs nothing and gets ONE clear error naming the
    // missing piece. The alternative this replaces is the failure mode that
    // motivated the whole change: running the emulated engine and reporting a
    // 200, which is a wrong answer attributed to the wrong runtime.
    const engineDecision = resolveChatSessionEngine({
      ...(target.host ? { hostTarget: target.host } : {}),
      model: {
        id: String(modelDefinition.id),
        ...(modelDefinition.provider
          ? { provider: modelDefinition.provider }
          : {}),
      },
      hasSelectedMcpServers: selectedServerIds.length > 0,
      // What a LATER turn will be able to resolve on its own. A session that
      // pins `serverIds` can be continued with no pointer at all, so a host
      // reached by pointer cannot survive on it — see the unpinnable-host rule.
      sessionPinsOwnServerIds: pins.serverIds !== undefined,
      toolPolicy: {
        toolMode: pins.toolMode,
        ...(body.allowedTools ? { allowedTools: body.allowedTools } : {}),
        ...(body.maxToolCalls !== undefined
          ? { maxToolCalls: body.maxToolCalls }
          : {}),
      },
    });
    if (!engineDecision.ok) {
      return v1Error(
        c,
        "FEATURE_NOT_SUPPORTED",
        `This host runs the ${engineDecision.harness} harness, which this turn can't run: ${engineDecision.reason}.`,
        {
          reason: "HARNESS_UNAVAILABLE",
          harness: engineDecision.harness,
          // Branch on the KIND, never on the wording — a copy edit to the
          // reason above must not change what a caller does about it.
          kind: engineDecision.kind,
          ...(target.host ? { hostId: target.host.hostId } : {}),
        },
      );
    }
    const engine: ChatSessionEngine = engineDecision.engine;

    // --- Connect ----------------------------------------------------------
    const connection = await createManualHostedConnection(
      c,
      {
        projectId,
        serverIds: selectedServerIds,
        ...(selectedServerNames ? { serverNames: selectedServerNames } : {}),
      },
      connectionSchema,
      {
        timeoutMs: CONNECT_TIMEOUT_MS,
        // This surface emulates no host persona — it is MCPJam's own agent —
        // and it ships the fulfiller, since `prepareChatV2` merges
        // `withServerSkills`, which loads only through the verified read path
        // in `server-skills.ts`. Without the declaration the extension can
        // never be active: the model is handed no `listSkills` / `loadSkill`
        // at all, so a server that serves skills is indistinguishable from one
        // that does not.
        advertiseSkillsExtension: true,
      },
    );
    manager = connection.manager;

    // Two ways to say "no tools", answered identically. `allowedTools: []` is
    // an allowlist that admits nothing, which is the same request as
    // `maxToolCalls: 0`; letting them diverge would make one of them the
    // subtly broken one.
    const noTools = wantsNoTools(body);

    const { excluded } = await computeExcludedToolNames(
      manager,
      selectedServerIds,
      {
        toolMode: pins.toolMode,
        ...(body.allowedTools ? { allowedTools: body.allowedTools } : {}),
        // "No tools" is enforced by not ADVERTISING any, not by letting the
        // model call one and refusing at dispatch: an advertised tool has
        // already cost prompt tokens and shaped the model's plan, and a turn
        // that answers "I tried to call a tool and was blocked" is not the
        // turn the caller asked for.
        ...(noTools ? { excludeAll: true as const } : {}),
      },
    );

    // The project's own skills, which this surface has never had. #4419 gave it
    // a connected server's skills by advertising the extension above; the
    // project pool was still invisible, so an agent driving MCPJam could read
    // somebody else's skills but not its own.
    //
    // TWO shapes, because a turn that named an environment is not a live turn.
    // An environment IS a decision about what runs, so its own resolved set is
    // the answer — pinned skill selection, attached plugin skills, captured
    // server skills and all. Only a turn pinning bare `serverIds` has no such
    // decision behind it, and only that turn builds a live set from the
    // project pool.
    //
    // The live shape stays lazy, like every other live surface: the catalog is
    // one query and a body is fetched only for the skill the model loads. A
    // catalog failure degrades to no skills rather than failing the turn.
    let turnCapabilities: EffectiveCapabilitySet | undefined;
    let capabilitiesAreLive = false;
    // The project pool is a MEMBER resource: `listCloudRuntimeSkills` resolves
    // `projectSkills:listSkills`, which is signed-in-only, and
    // `getConvexBearerForRequest` forwards a guest bearer verbatim. The v1 mount
    // already 401s guests on this path (`/chat-sessions/messages` is absent from
    // `guest-allowed-paths.ts`), so this term is unreachable today — it is here
    // because that allowlist is edited independently of this file, and the
    // reachable twin of this exact gate on the local route is what produced
    // CONVEX-19R.
    const callerIsGuest = Boolean(c.get("guestId"));
    if (target.environmentCapabilities) {
      turnCapabilities = target.environmentCapabilities;
    } else if (projectId && !callerIsGuest) {
      try {
        turnCapabilities = buildLiveEffectiveCapabilities({
          standaloneSkills: await listCloudRuntimeSkills({
            authHeader,
            projectId,
          }),
        });
        capabilitiesAreLive = true;
      } catch (error) {
        logger.warn(
          "[v1/chat-session-turn] project skill catalog unavailable",
          {
            projectId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
      ...(turnCapabilities
        ? {
            skillsSource: {
              kind: "resolved" as const,
              capabilities: turnCapabilities,
              // Only a LIVE set composes live server skills, and that is the
              // same rule `web-chat-turn` follows. An environment's server
              // skills were CAPTURED; fetching more from the connection would
              // falsify the claim that the set describes the turn — which is
              // exactly what this flag exists to prevent. On the live arm it
              // keeps #4419's server skills composed alongside the project's.
              ...(capabilitiesAreLive
                ? { composeLiveServerSkills: true as const }
                : {}),
              // The turn's own controller, so a lazy body or file read stops
              // with the turn instead of running to its own fetch timeout.
              abortSignal: abortController.signal,
            },
          }
        : {}),
      // Without this every server-skill ref is namespaced by the raw server
      // id, in the `listSkills` catalog the model reads AND in the origin
      // banner prepended to loaded skill content.
      ...(serverLabels ? { serverLabels } : {}),
      modelDefinition,
      ...(pins.systemPrompt ? { systemPrompt: pins.systemPrompt } : {}),
      ...(pins.temperature !== undefined
        ? { temperature: pins.temperature }
        : {}),
      ...(excluded.length > 0 ? { excludeMcpToolNames: excluded } : {}),
      // No progressive discovery: the caller chose this target deliberately
      // and wants to see what it advertises, not a search/load indirection.
      progressiveToolDiscovery: { enabled: false },
    });

    // STEPS ARE NOT CALLS, which is why `maxToolCalls` is enforced here rather
    // than folded into the step budget. One step can emit several parallel
    // tool calls, so a step bound limits round trips and would let a caller
    // who asked for "at most 2 calls" get five.
    //
    // Computed BEFORE `resolveTurnRuntime`, which inspects the advertised set:
    // handing it the uncapped one would let it decide on a tool surface the
    // turn is not going to run with.
    //
    // The ZERO case clears the FINAL set rather than trusting the name
    // exclusion above. `prepareChatV2` applies `excludeMcpToolNames` and THEN
    // merges skill/meta tools (`withServerSkills`), so a server advertising
    // the skills extension would still hand the model executable `listSkills`
    // / `loadSkill` entries on a turn that asked for no tools at all. Excluding
    // names bounds what is LOADED; clearing the set is what makes "zero" true.
    const tools = noTools
      ? ({} as ToolSet)
      : body.maxToolCalls !== undefined && body.maxToolCalls > 0
      ? capToolCalls(prepared.allTools, body.maxToolCalls)
      : prepared.allTools;

    const runtime = await resolveTurnRuntime({
      modelDefinition,
      projectId,
      authHeader,
      sourceType: "direct",
      chatSessionId: runtimeChatSessionId,
      serverIds: selectedServerIds,
      tools,
      // The harness selector rides the RUNTIME, which is where
      // `runUnifiedAssistantTurn` reads it from. Absent ⇒ the emulated engine,
      // byte-identical to every turn this surface ran before host targeting.
      ...(engine.kind === "harness" ? { harness: engine.harness } : {}),
    });
    // Never emulate a harness. `runAssistantTurn` would log-and-degrade, and a
    // local-BYOK resolution drops `harness` entirely — both would answer 200
    // for a runtime that never ran.
    assertHarnessDispatchable({ engine, runtimeKind: runtime.runtime.kind });

    const maxSteps = Math.max(
      1,
      Math.min(body.maxSteps ?? DEFAULT_MAX_STEPS, MAX_STEPS_CEILING),
    );

    const userMessage: ModelMessage = { role: "user", content: body.message };
    const inputMessages = [...priorMessages, userMessage];

    let lastEngineError:
      | { message: string; code?: string; httpStatus?: number }
      | undefined;

    // Past this line the turn may have spent. See `modelCallStarted`.
    modelCallStarted = true;
    const result = await runUnifiedAssistantTurn({
      runtime: runtime.runtime as never,
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      messages: inputMessages,
      modelDefinition,
      systemPrompt: prepared.enhancedSystemPrompt,
      tools,
      mcpClientManager: manager,
      authContext: { kind: "user_bearer", token: authHeader },
      sourceType: "direct",
      origin: "api",
      maxSteps,
      projectId,
      chatSessionId: runtimeChatSessionId,
      // How the harness's cloud sandbox reaches THIS inspector's MCP servers.
      // `runHarnessTurn` THROWS without it whenever servers are selected, and
      // this surface always has at least one — so a harness turn without it
      // could never have run. Same WEB-AUTHORIZED plane the eval runner and
      // the hosted chat routes resolve: this route builds an ephemeral
      // authorized manager exactly as they do, and deriving a different
      // strategy is how a sandbox ends up pointed at the wrong manager.
      ...(engine.kind === "harness"
        ? { harnessMcpProxy: resolveWebAuthorizedHarnessStrategy() }
        : {}),
      // The ENVIRONMENT's resolved skills, for the harness that will write them
      // into its sandbox. Without this `selectHarnessSkillSource` falls to its
      // `live` arm and the turn runs the whole PROJECT-WIDE catalog — the
      // environment's decision honoured by the emulated engine (through
      // `skillsSource` above) and silently discarded by the harness, which is
      // the same class of mismatch as running the wrong engine.
      //
      // Harness-only and presence-semantic. The emulated arm ignores this
      // field, so gating on the engine keeps every emulated turn byte-identical
      // rather than relying on a downstream reader to stay uninterested.
      //
      // What still does NOT cross: per-skill SUPPORTING FILES and pinned plugin
      // versions, which travel as `effectiveCapabilities` — an option
      // `runAssistantTurn` does not expose (the browser route reaches it
      // through `web-chat-turn`). So a harness turn here delivers the
      // environment's skill BODIES, not its attachments. Narrower than the
      // Playground, and no longer a different set.
      ...(engine.kind === "harness" && target.environmentSkills !== undefined
        ? { runtimeSkillsOverride: target.environmentSkills }
        : {}),
      abortSignal: abortController.signal,
      ...(prepared.progressivePlan
        ? { progressivePlan: prepared.progressivePlan }
        : {}),
      ...(prepared.discoveryState
        ? { discoveryState: prepared.discoveryState }
        : {}),
      onEngineError: (event: {
        message: string;
        code?: string;
        httpStatus?: number;
      }) => {
        lastEngineError = event;
      },
    } as never);

    await runtime.finalizeUsage(result);

    if (abortController.signal.aborted) {
      captureTurnEvent(c, {
        startedAt,
        outcome: "timeout",
        toolCallCount: result.toolCalls.length,
        engine: engineLabel(engine),
      });
      return v1Error(
        c,
        "TIMEOUT",
        `The turn exceeded the ${TURN_WALL_CLOCK_MS / 1000}s limit.`,
        { reason: "TURN_TIMEOUT" },
      );
    }

    // Hosted-engine failure contract, copied from the agent route because the
    // trap is the same: a spend-precheck denial returns 200 with a JSON body,
    // so `onEngineError` fires while `turnTrace` is still populated. Checking
    // only for a missing trace would answer a silent empty-reply 200.
    const rateLimitCodes = new Set(["user_rate_limit", "org_rate_limit"]);
    if (!result.turnTrace || lastEngineError) {
      const message =
        lastEngineError?.message ??
        "The turn failed: the engine returned no trace.";
      const rateLimited =
        lastEngineError?.httpStatus === 429 ||
        (lastEngineError?.code !== undefined &&
          rateLimitCodes.has(lastEngineError.code)) ||
        runtime.classifyFailure(message) === "rate_limited";
      captureTurnEvent(c, {
        startedAt,
        outcome: rateLimited ? "rate_limited" : "failed",
        toolCallCount: result.toolCalls.length,
        engine: engineLabel(engine),
      });
      return v1Error(
        c,
        rateLimited ? "RATE_LIMITED" : "INTERNAL_ERROR",
        message,
        {
          reason: rateLimited
            ? lastEngineError?.code ?? "ORG_RATE_LIMIT"
            : "TURN_FAILED",
        },
      );
    }

    // --- Persist ----------------------------------------------------------
    const resumeConfig: ResumeConfig = {
      ...(pins.systemPrompt ? { systemPrompt: pins.systemPrompt } : {}),
      ...(pins.temperature !== undefined
        ? { temperature: pins.temperature }
        : {}),
      selectedServers: selectedServerIds,
      // The four agent pins. First-write-wins is enforced at the ingest
      // boundary, so resending them on a continuation is harmless — and
      // sending them keeps a session created before a pin existed from
      // staying unpinned forever.
      modelId: pins.modelId,
      toolMode: pins.toolMode,
      ...(pins.environmentId ? { environmentId: pins.environmentId } : {}),
      ...(pins.serverIds ? { serverIds: pins.serverIds } : {}),
    };

    const persisted = await persistChatSessionToConvex(
      {
        chatSessionId: runtimeChatSessionId,
        modelId: String(modelDefinition.id),
        modelSource: runtime.modelSource,
        authHeader,
        projectId,
        sourceType: "direct",
        origin: "api",
        sessionMessages: result.messages,
        startedAt: existing?.startedAt ?? startedAt,
        lastActivityAt: Date.now(),
        resumeConfig,
        // The lease minted this id and the ingest dedupes on it. They MUST be
        // the same value: a fresh uuid here would leave the lease naming a
        // turn the transcript never records, and the replay branch above would
        // hand callers an id no read can resolve.
        turnTrace: { ...result.turnTrace, turnId: leaseTurnId },
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      },
      c,
    );

    if (persisted.outcome === "conflict") {
      return v1Error(
        c,
        "CONFLICT",
        "The session changed while this turn was running, so the transcript was not written. Re-read the session and retry.",
        {
          reason: "SESSION_VERSION_CONFLICT",
          ...(persisted.currentVersion !== undefined
            ? { currentVersion: persisted.currentVersion }
            : {}),
        },
      );
    }
    // The ingest either applied the turn or recognized it as already applied;
    // either way the lease's completion rides inside that mutation, so the
    // `finally` below must not release it.
    leaseSettled =
      persisted.outcome === "saved" || persisted.outcome === "duplicate";

    if (
      persisted.outcome === "failed" ||
      persisted.outcome === "not-attempted" ||
      persisted.outcome === "skipped"
    ) {
      // The turn RAN and SPENT. Reporting a 500 would tell the caller nothing
      // happened, and their retry would spend again — so this is a 200 whose
      // `persisted` block says plainly that the transcript did not land.
      logger.warn("[v1/chat-sessions] turn ran but was not persisted", {
        outcome: persisted.outcome,
        chatSessionId: runtimeChatSessionId,
      });
    }

    const sessionDocId =
      ("sessionDocId" in persisted ? persisted.sessionDocId : undefined) ??
      existing?._id ??
      lease.sessionId;

    captureTurnEvent(c, {
      startedAt,
      outcome: "ok",
      toolCallCount: result.toolCalls.length,
      engine: engineLabel(engine),
    });

    // No materialized project secret can be in this turn's payloads: this route
    // runs MCP SERVER TOOLS ONLY — there is no sandbox and no bash — so nothing
    // was ever delivered into a box for a tool to echo back. The parameter is
    // threaded rather than dropped so that the day this route gains a sandbox,
    // the scrub is already in the path instead of a thing to remember; wiring
    // it then is one assignment here.
    const secretScrubber = undefined;

    return v1Resource(c, {
      // May be null ONLY when the persist did not land — the caller then knows
      // from `persisted.outcome` that there is nothing to read back yet, which
      // is better than an id that resolves to nothing.
      sessionId: sessionDocId ?? null,
      turnId: leaseTurnId,
      // The project this turn ran in, which on a CONTINUATION the caller never
      // sent: it comes off the session row. Without it a caller holding only
      // this response cannot say where the session lives, and the session
      // permalink an agent is meant to hand back cannot be composed at all.
      projectId,
      reply: extractAssistantText(result),
      finishReason: result.finishReason ?? null,
      toolCalls: joinToolCalls(
        result.toolCalls,
        result.toolResults,
        secretScrubber,
      ),
      trace: {
        turnId: leaseTurnId,
        spanCount: result.turnTrace.spans?.length ?? 0,
        spans: result.turnTrace.spans ?? [],
      },
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens:
          (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      },
      model: {
        id: String(modelDefinition.id),
        provider: providerOf(pins.modelId),
      },
      toolMode: pins.toolMode,
      /**
       * WHICH ENGINE RAN — `"emulated"` or `"harness:<id>"`, on every turn.
       *
       * Not decoration. This surface used to answer 200 for a harness-declaring
       * target while running the emulated engine, and the response said nothing
       * either way, so nothing downstream could tell. It is also what a caller
       * reads back the host from: a continuation that means to stay on a
       * harness re-sends the `hostId` reported alongside it, and one that
       * forgets is refused rather than answered by the other engine.
       */
      engine: engineLabel(engine),
      // The host this turn executed as, when there was one. Server-resolved —
      // an environment's own host, or the pointer the caller sent.
      ...(target.host ? { hostId: target.host.hostId } : {}),
      advertisedToolCount: Object.keys(tools).length,
      excludedToolCount: excluded.length,
      // Present only when the client asked for something this surface does not
      // run, so a caller that never configures built-ins sees no new field.
      ...(target.unappliedCapabilities
        ? { unappliedCapabilities: target.unappliedCapabilities }
        : {}),
      persisted: {
        outcome: persisted.outcome,
        ...("version" in persisted && persisted.version !== undefined
          ? { version: persisted.version }
          : {}),
      },
      origin: "api" as const,
    });
  } finally {
    clearTimeout(wallClock);
    requestSignal.removeEventListener("abort", onRequestAbort);
    // Detached rather than awaited: the response is already computed, and a
    // slow Convex round-trip must not delay it.
    if (shouldReleaseLease({ leaseTurnId, leaseSettled, modelCallStarted })) {
      void releaseTurnLease(client, leaseTurnId!);
    }
    releaseTurnSlot(orgKey);
    try {
      void manager?.disconnectAllServers().catch((error) => {
        logger.warn("[v1/chat-sessions] MCP manager teardown failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.warn(
        "[v1/chat-sessions] MCP manager teardown threw synchronously",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

/** Minimal body shape `createManualHostedConnection` authorizes against. */
const connectionSchema = z.object({
  projectId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  serverNames: z.array(z.string()).optional(),
});

/** Flatten this turn's assistant output to text. */
function extractAssistantText(result: {
  assistantMessages: Array<{ content: unknown }>;
}): string {
  const parts: string[] = [];
  for (const message of result.assistantMessages) {
    if (typeof message.content === "string") {
      if (message.content) parts.push(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

/**
 * Server-authoritative telemetry. Names, outcomes, counts and durations ONLY —
 * the messages and tool payloads on this route are customer conversation
 * content and never leave in an analytics event.
 */
function captureTurnEvent(
  c: Parameters<typeof captureServerEvent>[0],
  data: {
    startedAt: number;
    outcome: "ok" | "failed" | "rate_limited" | "timeout";
    toolCallCount: number;
    /** `"emulated"` | `"harness:<id>"`. Server-derived, never body-supplied. */
    engine: string;
  },
): void {
  captureServerEvent(c, "api_chat_session_turn_completed", {
    surface: "api",
    outcome: data.outcome,
    duration_ms: Date.now() - data.startedAt,
    tool_call_count: data.toolCallCount,
    engine: data.engine,
  });
}

export const __testing = {
  assertUnambiguousModelId,
  capToolCalls,
  narrowTarget,
  serverLabelsFor,
  shouldReleaseLease,
  wantsNoTools,
  computeExcludedToolNames,
  unappliedBuiltInToolIds,
  hostSelectedServerIds,
  CONFIG_FIELDS,
  turnSchema,
};

export type { TurnBody };
