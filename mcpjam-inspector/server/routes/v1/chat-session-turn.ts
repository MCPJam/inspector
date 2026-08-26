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
import { MODEL_ID_PREFIX_TO_PROVIDER } from "@/shared/model-provider";
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
} from "../../services/environments/runtime.js";
import { logger } from "../../utils/logger.js";
import { captureServerEvent } from "../../utils/analytics.js";
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
}

/**
 * Resolve which MCP servers this turn talks to.
 *
 * The caller names an environment or a list of server IDS — never raw server
 * CONFIGS. That is the same rule the eval run-start route enforces: accepting
 * configs on a public endpoint would let a caller point our egress at an
 * arbitrary host under their own project's credentials.
 */
async function resolveTarget(
  client: ConvexHttpClient,
  projectId: string,
  input: { environmentId?: string; serverIds?: string[] },
): Promise<ResolvedTarget> {
  if (input.serverIds && input.serverIds.length > 0) {
    return { serverIds: input.serverIds };
  }
  if (!input.environmentId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A first turn must name its target: pass environmentId or serverIds.",
    );
  }
  const spec = await resolveEnvironmentForRuntime(client, {
    projectId,
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
  return {
    serverIds,
    ...(serverNames.length === serverIds.length ? { serverNames } : {}),
    environmentId: input.environmentId,
  };
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
    tools = (await manager.getTools(serverIds)) as typeof tools;
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
    const target = await resolveTarget(client, projectId, {
      ...(pins.environmentId ? { environmentId: pins.environmentId } : {}),
      ...(pins.serverIds ? { serverIds: pins.serverIds } : {}),
    });
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

    const modelDefinition = await resolveHostModelDefinition({
      modelId: pins.modelId,
      projectId,
      auth: { authHeader },
    });

    // --- Connect ----------------------------------------------------------
    const connection = await createManualHostedConnection(
      c,
      {
        projectId,
        serverIds: selectedServerIds,
        ...(selectedServerNames ? { serverNames: selectedServerNames } : {}),
      },
      connectionSchema,
      { timeoutMs: CONNECT_TIMEOUT_MS },
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

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: selectedServerIds,
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
    });

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
    });

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
      toolCalls: joinToolCalls(result.toolCalls, result.toolResults),
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
      advertisedToolCount: Object.keys(tools).length,
      excludedToolCount: excluded.length,
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
  },
): void {
  captureServerEvent(c, "api_chat_session_turn_completed", {
    surface: "api",
    outcome: data.outcome,
    duration_ms: Date.now() - data.startedAt,
    tool_call_count: data.toolCallCount,
  });
}

export const __testing = {
  assertUnambiguousModelId,
  capToolCalls,
  narrowTarget,
  shouldReleaseLease,
  wantsNoTools,
  computeExcludedToolNames,
  CONFIG_FIELDS,
  turnSchema,
};

export type { TurnBody };
