/**
 * `runHarnessTurn` — the real Claude Code runtime behind a host's
 * `harness: "claude-code"` field. Drop-in alternative to `runChatEngineLoop`:
 * same `(MCPJamHandlerOptions, streamSink)` in, same `ChatEngineLoopResult`
 * out, same callbacks/trace, so chat / playground / eval all reuse it through
 * `runAssistantTurn`.
 *
 * Instead of MCPJam's emulated Convex `/stream` loop, it runs the AI SDK
 * **Claude Code harness** inside the host's E2B computer (Phase 2 provider),
 * attaches the host's MCP servers via a generated `.mcp.json` (Phase 3), and
 * adapts the harness event stream back into MCPJam's UI chunks + persistence.
 *
 * ── dual-`ai` boundary ────────────────────────────────────────────────────
 * The harness packages run on `ai@7-canary` (installed nested); this server is
 * `ai@6`. We never let v7 types cross into the typed server code: the harness
 * `fullStream` is read LOOSELY (by part `type`) and we hand-build `ai@6`
 * `UIMessageChunk`s. The `agent.stream(...)` input is cast at the call site.
 *
 * ── NOT runtime-verified here ─────────────────────────────────────────────
 * This compiles against the real APIs, but the live path (E2B connect, harness
 * bootstrap, exact fullStream part shapes, transcript reconstruction) needs a
 * live box + a model credential to exercise — same gate the Phase 0 spike ran.
 * Treat the stream-part mapping + message reconstruction as first-cut until a
 * live run confirms them.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type FinishReason,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import {
  HarnessAgent,
  collectHarnessAgentToolApprovalContinuations,
} from "@ai-sdk/harness/agent";
import {
  emitTraceSnapshot,
  getPromptIndex,
  setToolSpanMessageRangesFromResults,
} from "../live-chat-trace-stream.js";
import { StreamTurnDriver } from "../stream-turn-driver.js";
import {
  getHarnessAdapter,
  buildBrokerDummyAuth,
  type HarnessAuth,
} from "./registry.js";
import type { HarnessV1PermissionMode } from "@ai-sdk/harness";
import {
  startHarnessModelBroker,
  revokeHarnessModelBroker,
  reserveHarnessBox,
  releaseHarnessBoxReservation,
  renewHarnessBoxReservation,
  type HarnessBrokerBox,
} from "./harness-model-broker.js";
import { harnessBrokerDeliveryEnabled } from "./harness-flags.js";
import {
  emitError,
  emitFinish,
  emitReasoningDelta,
  emitReasoningEnd,
  emitReasoningStart,
  emitTextDelta,
  emitTextEnd,
  emitTextStart,
  emitToolApprovalRequest,
  emitToolInput,
  emitToolOutput,
} from "../chat-stream-chunks.js";
import { mergeMcpToolOriginMetadata } from "@/shared/mcp-tool-origin-metadata";
import {
  pluginOriginByServerId,
  type RuntimePluginVersion,
} from "../../services/environments/effective-capabilities.js";
import { projectSelectedMcpServersAsHostTools } from "./host-executed-mcp-tools.js";
import {
  capabilitySkillFiles,
  deliveredPluginSkillOrigins,
  pluginSkillDeliverySummary,
  pluginVersionsFingerprint,
  selectDeliverableServerIds,
} from "./plugin-delivery.js";
import { logger } from "../logger.js";
import {
  createSystemStreamFailureReporter,
  oncePerTurn,
} from "../stream-failure-reporter.js";
import type {
  ChatEngineLoopResult,
  MCPJamHandlerOptions,
} from "../mcpjam-stream-handler.js";
import {
  writePersistReceipt,
  type PersistedTurnTrace,
} from "../chat-ingestion.js";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { createOffsetInterval } from "@/shared/eval-trace";
import { getCanonicalModelId } from "@/shared/types";
import { createE2BHarnessSandboxProvider } from "./e2b-sandbox-provider.js";
import {
  prepareLocalHarnessTurn,
  type PreparedLocalHarnessTurn,
} from "./local/local-turn.js";
import { localPermissionModeFor } from "./local/compatibility.js";
import {
  resolveWorkingDirectory,
  HOME_ROOT,
} from "../computers/path-confine.js";
import { resolveHarnessSandbox } from "./resolve-sandbox.js";
import {
  fetchRuntimeSkills,
  fetchRuntimeSkillFiles,
  skillsFingerprint,
} from "./runtime-skills.js";
import { deliveredSecretsFingerprint, toSecretEnv } from "./runtime-secrets.js";
import {
  externalAccountPlanWallError,
  isExternalAccountPlanWallTurn,
} from "./external-account-plan-wall.js";
import {
  fetchBrokeredCredentialNames,
  planExternalAccountCredentials,
  type ExternalAccountCredentialPlan,
} from "./external-account-credentials.js";
import { materializeSkillFiles } from "./materialize-skill-files.js";
import { materializePinnedSkillFiles } from "./pinned-harness-skills.js";
import { selectHarnessSkillSource } from "./skill-delivery.js";
import { materializeSkillFrontmatter } from "./materialize-skill-frontmatter.js";
import {
  handOffLegacySkillDirs,
  preseedAdapterSkills,
} from "./preseed-adapter-skills.js";
import {
  reconcileSkillDirs,
  appendManagedSkills,
} from "./reconcile-skill-dirs.js";
import {
  adoptSandboxSkills,
  shouldAdoptSandboxSkills,
} from "./adopt-sandbox-skills.js";
import {
  claimHarnessSessionState,
  commitHarnessSessionState,
  getHarnessResumeEligibility,
  heartbeatHarnessSessionState,
  releaseHarnessSessionState,
  type HarnessOwnerRef,
  type HarnessSessionCommitPayload,
} from "./harness-session-state.js";
import type { HarnessResetReason } from "@/shared/harness-session";
import {
  buildHarnessProxyMcpJson,
  harnessServerKeyToName,
  type HarnessProxyServerInput,
} from "./mcp-config.js";
import {
  resolveHarnessProxyUrl,
  type HarnessMcpProxyStrategy,
} from "./harness-proxy-strategy.js";
import { fetchHarnessProxyTokens } from "./harness-proxy-token-client.js";
import type { HarnessEvidenceDecision } from "./harness-proxy-token-client.js";
import {
  isSealedHarnessProxyToken,
  sealHarnessProxyToken,
} from "./harness-proxy-policy-seal.js";
import {
  readHarnessPolicyBlockFromResult,
  type HarnessPolicyBlockRecord,
} from "./harness-proxy-policy-enforcement.js";
import {
  startCrossInstanceHarnessPolicyBlockPoll,
  subscribeHarnessPolicyBlocks,
  type HarnessPolicyBlockEvent,
} from "./harness-policy-block-channel.js";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  harnessScopeStepUpServerMatches,
  matchHarnessScopeStepUpToolCall,
  subscribeHarnessScopeStepUp,
  type HarnessScopeStepUpEvent,
  type ObservedHarnessToolCall,
} from "./harness-scope-step-up.js";
import {
  emitInsufficientScopeChunk,
  emitScopeStepUpRequiredChunk,
} from "../../routes/web/hosted-elicitation.js";
import { harnessToolApprovalRefusalReason } from "./harness-availability.js";

/** A minimal writer matching what `createUIMessageStream` hands `execute` and
 *  what the no-op (`streamSink: "none"`) path supplies. */
type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

export const HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT =
  "The harness completed the turn without returning a visible message.";

/**
 * Build the harness `.mcp.json` — "always-proxy". Every selected, registered
 * server points at MCPJam's own proxy (carrying a signed `X-MCPJam-Proxy-Token`
 * and NO upstream credentials); MCPJam forwards to the real server, so the
 * harness's MCP runs through the playground. The `harnessMcpProxy` strategy
 * (set by the caller route, NOT a global env) decides the URL per plane —
 * tunnel + adapter-http (local) or direct `/api/web/harness-mcp` (hosted). A
 * selected id with no live config is skipped.
 */
export async function buildHarnessProxyMcpJsonFromManager(args: {
  manager: MCPJamHandlerOptions["mcpClientManager"];
  selectedServerIds: string[];
  authHeader: string;
  projectId: string;
  strategy: HarnessMcpProxyStrategy;
  scopeStepUpCorrelationId: string;
  /** Plugin origin per server id (INS-7). A plugin-contributed server that
   *  can't be delivered fails the turn instead of being skipped. */
  pluginOrigins?: Record<string, RuntimePluginVersion>;
  /**
   * Per-server resolved `toolPolicy` decisions for this run. A server with a
   * snapshot gets a SEALED token (policy + credential in one opaque value) so
   * the out-of-process MCP calls are enforced at the proxy; a server without
   * one keeps today's bare token.
   */
  toolPolicy?: Record<string, ToolPolicySnapshot>;
  /** Seal expiry for the sealed envelope (unix ms). */
  toolPolicySealExpiresAtMs?: number;
  /**
   * The eval iteration and turn this `.mcp.json` is being built for.
   *
   * Present only for a harness eval turn on a run that froze evidence capture
   * on. It makes the mint ask for tokens carrying an AUTHORIZED iteration
   * claim, and puts the turn id on every server entry's headers — the two
   * halves the proxy needs before it will record anything. Absent for
   * playground traffic and for capture-off runs, which mint and build exactly
   * as they did before evidence existed.
   */
  evidenceScope?: { iterationId: string; turnId: string };
}) {
  const {
    manager,
    selectedServerIds,
    authHeader,
    projectId,
    strategy,
    pluginOrigins,
    scopeStepUpCorrelationId,
    toolPolicy,
    evidenceScope,
  } = args;
  const configured = selectDeliverableServerIds({
    selectedServerIds,
    hasLiveConfig: (id) => Boolean(manager.getServerConfig(id)),
    ...(pluginOrigins ? { pluginOrigins } : {}),
    onSkipped: (id) =>
      logger.warn(
        `[harness] selected server has no live config; skipping serverId=${id}`,
      ),
  });

  const inputs: HarnessProxyServerInput[] = [];
  let mintedHarnessEvidence: HarnessEvidenceDecision | undefined;
  if (configured.length > 0 && strategy.plane === "web-authorized") {
    // HOSTED plane: servers are persisted Convex rows, and the harness-mcp route
    // rebuilds the connection per-request via acting-as. Convex mints a signed
    // identity token per server (bearer-authed + access-checked). Fail closed:
    // no tokens ⇒ the harness can't proxy.
    const minted = await fetchHarnessProxyTokens({
      projectId,
      serverIds: configured,
      bearer: authHeader,
      // All-or-nothing on the scope too: a 422 here fails the turn rather than
      // quietly minting claimless tokens, which would run the whole iteration
      // recording nothing.
      ...(evidenceScope
        ? { evalScope: { iterationId: evidenceScope.iterationId } }
        : {}),
    });
    if (!minted.ok) {
      throw new Error(
        `Couldn't mint harness MCP proxy tokens (${minted.status}): ${minted.error}`,
      );
    }
    mintedHarnessEvidence = minted.harnessEvidence;
    // Hard-fail, never skip: the harness must run with every selected server or
    // none — a silently-dropped server means the agent runs with missing MCP
    // tools, which is far worse to debug than a clear up-front failure. (The
    // mint endpoint is already all-or-nothing — 422 on any malformed/unauthorized
    // id — so this guards an unexpected partial response.)
    for (const id of configured) {
      const token = minted.tokens[id];
      if (!token) {
        throw new Error(
          `Harness MCP proxy: no token minted for selected serverId=${id} — refusing to run with missing MCP tools`,
        );
      }
      const url = await resolveHarnessProxyUrl({
        strategy,
        serverId: id,
        authHeader,
      });
      const policy = toolPolicy?.[id];
      inputs.push({
        name: id,
        proxyUrl: url,
        // A policied server carries the SEALED token INSTEAD of the bare one:
        // the sandbox must not hold a working unpoliced credential, or removing
        // the policy from `.mcp.json` would restore unpoliced access. Sealing
        // throws when the deployment can't seal — refusing the run rather than
        // running it unenforced.
        ...(policy
          ? {
              sealedProxyToken: sealHarnessProxyToken({
                token,
                serverId: id,
                policy,
                expiresAtMs:
                  args.toolPolicySealExpiresAtMs ??
                  Date.now() + DEFAULT_POLICY_SEAL_TTL_MS,
              }),
            }
          : { proxyToken: token }),
        scopeStepUpCorrelationId,
        // Only when the MINT confirmed capture: the run's frozen decision is
        // the authority, and sending a turn id for a run that froze capture
        // off would arm nothing while still changing the sandbox's config.
        ...(evidenceScope && minted.harnessEvidence?.captureEnabled
          ? { evidenceTurnId: evidenceScope.turnId }
          : {}),
      });
    }
  } else if (configured.length > 0) {
    // LOCAL plane: servers live in the persistent manager (often just local
    // names with no Convex row), reached through the per-server adapter tunnel.
    // The tunnel's `?k=` secret is the auth (adapter-http validate-when-present)
    // — no Convex identity token to mint.
    // The local plane's route (`adapter-http`) is validate-when-present: a
    // dropped token still works, so a sealed policy would not be enforceable
    // there. A policied run must never reach it.
    if (toolPolicy) {
      throw new Error(
        "TOOL_POLICY_UNSUPPORTED: a tool policy cannot be enforced on the local-mcp harness plane (adapter-http accepts an absent proxy token), so the run is refused rather than run unenforced",
      );
    }
    for (const id of configured) {
      const url = await resolveHarnessProxyUrl({
        strategy,
        serverId: id,
        authHeader,
      });
      inputs.push({ name: id, proxyUrl: url, scopeStepUpCorrelationId });
    }
  }
  // DERIVE, don't declare: verify the assembled config actually carries a
  // sealed token for every policied server. A policied entry that ended up with
  // a bare token would be an unenforced run.
  const mcpJson = buildHarnessProxyMcpJson(inputs);
  if (toolPolicy) {
    const keyToName = harnessServerKeyToName(inputs);
    for (const [key, entry] of Object.entries(mcpJson.mcpServers)) {
      const serverId = keyToName[key];
      if (!serverId || !toolPolicy[serverId]) continue;
      const header = entry.headers?.["X-MCPJam-Proxy-Token"];
      if (!isSealedHarnessProxyToken(header)) {
        throw new Error(
          `TOOL_POLICY_UNSEALED: harness .mcp.json entry for serverId=${serverId} carries an unsealed proxy token while a tool policy is in force — refusing to run unenforced`,
        );
      }
    }
  }
  return {
    mcpJson,
    // Sanitized .mcp.json key → serverId, so Claude Code's mcp__<key>__<tool>
    // tool names map back to a serverId for eval matching / spans / MCP App
    // rendering (which all key off serverId + the un-namespaced tool name).
    keyToServerId: harnessServerKeyToName(inputs),
    // What the MINT said this run froze, when a scope was asked for. The
    // caller reads it rather than the flag: this is the run's decision as the
    // control plane recorded it at creation, not today's flag value.
    ...(mintedHarnessEvidence
      ? { harnessEvidence: mintedHarnessEvidence }
      : {}),
  };
}

/** The Claude Code harness serializes MCP tool-call arguments as a JSON STRING
 *  (e.g. `'{"city":"NYC"}'`), but MCPJam's UI chunks, the onToolCall callback,
 *  eval arg-matching, and MCP App widget capture all expect the structured
 *  object. Parse a string input back to its object/array; fall back to the raw
 *  value when it isn't JSON or doesn't decode to a structure (don't coerce a
 *  bare string/number/bool, and pass already-structured inputs through). */
function coerceToolInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : raw;
  } catch {
    return raw;
  }
}

/** AI-SDK `ToolResultPart.output` discriminators we must NOT re-wrap. */
const TYPED_TOOL_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "json",
  "text",
  "error-text",
  "content",
]);

/** Build the persisted `tool-result` `output` for a harness tool result, matching
 *  the emulated engine's canonical single-wrap shape (shared/http-tool-calls.ts).
 *
 *  The harness `tool-result` part's `.output` (`event.result`) is the RAW result
 *  for most tools, but some tools — and computer-use / image results — already
 *  hand back an already-typed `{type, value}` output. Blindly wrapping that as
 *  `{type:"json", value: rawOutput}` produced the double-nested
 *  `{type:json,value:{type:json,value:…}}` seen in persisted transcripts. So:
 *  errors → `error-text`; an already-typed output passes through unchanged;
 *  anything else is wrapped once as `{type:"json", value}`. */
export function toToolResultOutput(
  rawOutput: unknown,
  isError: boolean,
): { type: string; value: unknown } {
  if (isError) {
    return {
      type: "error-text",
      value:
        typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput),
    };
  }
  if (
    rawOutput !== null &&
    typeof rawOutput === "object" &&
    typeof (rawOutput as { type?: unknown }).type === "string" &&
    TYPED_TOOL_OUTPUT_TYPES.has((rawOutput as { type: string }).type) &&
    "value" in (rawOutput as object)
  ) {
    return rawOutput as { type: string; value: unknown };
  }
  return { type: "json", value: rawOutput };
}

/** Per-process id for lease attribution (logs/debugging). */
const HARNESS_INSTANCE_ID = crypto.randomUUID();
/** Lease TTL handed to Convex; heartbeats extend it while streaming. Real Claude
 *  Code turns can exceed this, so it's the crash-recovery bound, not the normal
 *  run bound (we heartbeat well within it). */
const HARNESS_LEASE_TTL_MS = 5 * 60_000;
const HARNESS_HEARTBEAT_MS = 90_000;
// The backend reservation TTL is deliberately much longer than this interval.
// A missed renewal aborts preparation immediately; the longer server-side TTL
// is the crash-recovery backstop for a worker that disappears altogether.
const HARNESS_RESERVATION_HEARTBEAT_MS = 60_000;
// v7: gateway base URL normalization (Anthropic-protocol origin without /v1) —
// resumed sessions reconnect to a bridge process holding the OLD env, so force
// fresh sessions to pick up the corrected ANTHROPIC_BASE_URL.
const HARNESS_RUNTIME_COMPAT_VERSION = 7;

/** Stable hash of the session-scoped runtime inputs. A change forces a fresh
 *  harness session (a resumed Claude Code thread keeps the model/tools it was
 *  created with, so changing those mid-session is unsafe).
 *
 *  Deliberately EXCLUDES the system prompt. The inspector hands us the per-turn
 *  `effectiveEnhancedSystemPrompt`, which app/widget chats augment EVERY turn
 *  with live widget model context (web-chat-turn buildWidgetModelContextSystem-
 *  Prompt). Hashing it flipped the fingerprint each turn and cold-started every
 *  app/widget conversation. A resumed thread keeps its original instructions
 *  regardless, so the prompt isn't a safe fork trigger; model + server set are
 *  the stable, resume-invalidating dimensions. */
export function harnessRuntimeFingerprint(parts: {
  /** The harness id MUST be part of the fingerprint: two hosts that share
   *  model/servers/permission but run different runtimes are NOT resume-
   *  compatible, so a Codex turn must never reuse a Claude Code session lane. */
  harnessId: string;
  modelId: string;
  selectedServers?: string[];
  permissionMode: string;
  /**
   * INS-7: the plugin versions materialized for this turn. A resumed session
   * keeps whatever plugin runtime was delivered when it was CREATED, so an
   * environment that now pins a different version — or the same version with
   * different bundle content — is not resume-compatible and must fork.
   *
   * Neither existing dimension covers this. The server-id set does not: a new
   * immutable version can expose the SAME materialized server ids. `skillsHash`
   * does not either: it folds skill text, not the bundle a skill's supporting
   * files and component servers come from.
   *
   * Appended ONLY when non-empty, so a plugin-less turn hashes byte-identically
   * to before this dimension existed and its sessions keep resuming.
   */
  pluginVersions?: RuntimePluginVersion[];
  /**
   * The MATERIALIZED project secrets delivered into this turn's box
   * (`deliveredSecretsFingerprint` — a digest, never a value).
   *
   * A resumed session reattaches to a bridge process holding the environment it
   * was CREATED with, so a rotated credential would otherwise be delivered to a
   * box that already has the old one. Forking is the only way a rotation
   * reaches an in-flight conversation.
   *
   * Appended ONLY when non-empty, so a secretless turn hashes byte-identically
   * to before this dimension existed and its sessions keep resuming. A fetch
   * FAILURE omits it entirely (see the call site) rather than sending `""`,
   * which would read as "the secrets were removed".
   */
  secretsHash?: string;
  /**
   * WHICH TRANSPORT the adapter speaks, when a harness has more than one.
   *
   * Codex has two: the published `codex exec` adapter and MCPJam's own
   * `codex app-server` one. They share a harness id — one Codex host, one
   * history — but they are NOT resume-compatible: a session created over exec
   * has no app-server thread to resume, and a live bridge speaks one protocol
   * only. Flipping the transport flag under a running conversation would
   * otherwise reattach it to a bridge that cannot understand the next frame.
   *
   * Appended ONLY when set and not the default `"exec"`, so every existing
   * session — Codex and Claude Code and Cursor alike — hashes byte-identically
   * to before this dimension existed and keeps resuming. An unconditional
   * append would fork the whole fleet on deploy, which is the cost
   * `HARNESS_RUNTIME_COMPAT_VERSION` exists to make deliberate.
   */
  transport?: string;
  /**
   * WHERE this turn runs, and — for the local target — exactly what it runs.
   *
   * A resumed harness session reattaches to a bridge process that already
   * exists, so a session created against a cloud box can never be resumed on a
   * laptop, or the other way round. That much the kind alone settles.
   *
   * The runtime id, the workspace grant and the policy version are folded in
   * for the reason every other dimension here is: a resumed session keeps the
   * runtime, directory and permission policy it was CREATED with, so a change
   * to any of them has to fork rather than silently continue under terms the
   * user did not agree to. Consent is bound to exactly this set, so a resumed
   * session that skipped the fork would be running under a grant that no longer
   * describes it.
   *
   * Appended ONLY for a local turn, so every hosted turn hashes byte-identically
   * to before this dimension existed and its sessions keep resuming.
   */
  localTarget?: {
    runtimeId: string;
    workspaceGrantId: string;
    policyVersion: string;
    /**
     * The CONSENTED profile, named rather than inferred.
     *
     * `permissionMode` above already differs per profile today, so this is
     * redundant — right up until two profiles map to the same mode, at which
     * point a profile change would stop forking the session and a resumed
     * thread would keep terms the user has since changed. Consent binds to the
     * profile, so the fingerprint names the profile.
     */
    permissionProfile: string;
  };
  /**
   * EXTERNAL-ACCOUNT harnesses need no field of their own here, and this note
   * is why rather than an oversight. Their credential is a materialized project
   * secret, so a rotation already forks through `secretsHash`; and the harness
   * id is a literal PREFIX of the returned fingerprint, so a cursor session can
   * never resume into a brokered lane whatever else matches. The one dimension
   * that looks missing — the model — is genuinely absent from the turn: the
   * adapter passes none, so there is nothing to fork on.
   */
}): string {
  const pluginDimension = pluginVersionsFingerprint(parts.pluginVersions ?? []);
  const s = [
    String(HARNESS_RUNTIME_COMPAT_VERSION),
    (parts.selectedServers ?? []).slice().sort().join(","),
    parts.permissionMode,
    ...(pluginDimension ? [pluginDimension] : []),
    ...(parts.secretsHash ? [parts.secretsHash] : []),
    ...(parts.transport && parts.transport !== "exec"
      ? [`transport:${parts.transport}`]
      : []),
    // Appended like every other optional dimension, and separated by the same
    // 0x01 delimiter above — so a runtime id ending where a grant id begins
    // cannot hash the same as a different pair.
    //
    // AFTER `transport`, deliberately. Order is the hash: keeping `transport`
    // where it already sits means every Codex app-server session created
    // before this branch merged still hashes byte-identically and keeps
    // resuming. Only a local turn — which no existing session is — picks up a
    // new dimension.
    ...(parts.localTarget
      ? [
          `local-native:${parts.localTarget.runtimeId}:` +
            `${parts.localTarget.workspaceGrantId}:` +
            `${parts.localTarget.policyVersion}:` +
            `${parts.localTarget.permissionProfile}`,
        ]
      : []),
  ].join("");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${parts.harnessId}|${parts.modelId}|${(h >>> 0).toString(16)}`;
}

/**
 * Deadline for every network call on the TURN-END path.
 *
 * These all run after the model stream has finished, when nothing is waiting on
 * the result and a miss is backstopped by something else (lease TTL, the broker
 * cron, the sandbox GC, the next turn's re-claim). What they must never do is
 * BLOCK: the harness turn does not return until they settle, so on the swarm
 * surface an unbounded one holds `runSyntheticHostSession` open, which holds
 * the runner's per-attempt `finally` open — the disposable box is never
 * released and the transcript and terminal attempt are never persisted. A
 * single slow dependency silently eats a worker slot and loses the run's data.
 *
 * Note that `.catch(() => {})` on these calls does NOT cover this. It swallows
 * REJECTIONS; a hang never rejects. That is precisely what makes the failure
 * invisible on inspection, so the deadline is the thing doing the work here.
 *
 * Same shape and rationale as `RELEASE_REQUEST_TIMEOUT_MS` in
 * `sessionSimulation/swarm-sandbox.ts` — one idiom for bounded cleanup.
 */
const HARNESS_TEARDOWN_TIMEOUT_MS = 15_000;

/** Sealed-policy envelope lifetime when the caller doesn't set one. Long enough
 *  for a real harness turn, short enough to bound a leaked seal (§3's
 *  out-of-scope replay is bounded by exactly this and the inner token's own
 *  expiry). */
const DEFAULT_POLICY_SEAL_TTL_MS = 6 * 60 * 60_000;

export async function runHarnessTurn(
  options: MCPJamHandlerOptions,
  streamSink: "ui" | "none",
): Promise<ChatEngineLoopResult> {
  const {
    messages,
    modelId: rawModelId,
    provider,
    systemPrompt,
    authHeader,
    projectId,
    mcpClientManager,
    selectedServers,
    abortSignal,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    onToolCall,
    onToolResult,
    onStepFinish,
    onEngineError,
    failureReporter: failureReporterOption,
    onLiveTextDelta,
    requireToolApproval,
    modelVisibleMcpToolResults,
    respectToolVisibility,
    tasks,
    chatSessionId,
    scenarioId,
    sourceType,
    journeyRunId,
    hostId,
    harness,
    harnessMcpProxy,
    harnessToolPolicy,
    evalIterationId,
    onHarnessEvidenceDecision,
    onHarnessPolicyBlocks,
    builtInTools,
    computerWorkdir,
    harnessSandboxBinding,
    harnessExecutionTarget,
    executionScope,
    pinnedHarnessSkills,
    runtimeSkillsOverride,
    effectiveCapabilities,
    environmentId,
    environmentUnresolvedReason,
    runtimeSecrets: runtimeSecretsOverride,
    secretsUnavailable,
    onSecretEnvDelivered,
    createHarnessScopeStepUpContinuation,
  } = options;
  // One typed route.operation.failed per turn; the system fallback covers
  // callers with no request context (evals/swarms).
  const failureReporter = oncePerTurn(
    failureReporterOption ?? createSystemStreamFailureReporter("harness-turn"),
  );
  // Canonicalize the model id up front (bare hosted ids like `gpt-5-nano` →
  // `openai/gpt-5-nano`). Everything downstream — supportsModel, the adapter's
  // toNativeModel (Codex only maps the `openai/gpt-5*` form), credential
  // attribution, fingerprint — relies on the canonical form, so a bare id can't
  // make Codex silently fall back to its default model.
  const modelId = getCanonicalModelId(rawModelId, provider);
  // The harness adapter declares the per-harness bits (auth, native model
  // mapping, MCP delivery, tool-name attribution, file-change naming, approval,
  // skills). runHarnessTurn stays harness-agnostic and reads capabilities off it.
  //
  // Defensive: this path is only reached when a harness is selected (the dispatch
  // gates on a validated id), but eval/synthetic forward `harness` unconditionally
  // — so require it here rather than silently defaulting to claude-code, and let
  // getHarnessAdapter throw on an unknown id instead of mis-attributing the turn.
  if (!harness) {
    throw new Error("runHarnessTurn: harness id is required");
  }
  // An ephemeral box is launcher-owned and billed to its run's project; an
  // execution scope is the host-funded GUEST path, which resolves a scenario's
  // own personal computer and bills the host org. The two authorize and bill
  // differently, so a turn asking for both is a wiring bug. The backend rejects
  // the combination outright — surface it HERE, before the box is bound and a
  // credential is minted, rather than as an opaque 400 mid-turn.
  if (harnessSandboxBinding && executionScope) {
    throw new Error(
      "runHarnessTurn: an ephemeral sandbox binding cannot be combined with " +
        "an execution scope (the guest/host-funded path runs on the scenario's " +
        "own computer)",
    );
  }
  const harnessAdapter = getHarnessAdapter(harness);

  // The engine mutates a single messageHistory ref through the turn (parity
  // with runChatEngineLoop); we seed it with the inbound prompt messages.
  const messageHistory: ModelMessage[] = [...messages];
  const turnStartedAt = Date.now();
  const turnId = crypto.randomUUID();
  // Per-turn prompt index (user-message count − 1), computed from the inbound
  // history like runChatEngineLoop's getPromptIndex. Hardcoding 0 collapses a
  // multi-turn session: persisted traces rehydrate sorted by promptIndex, so
  // every turn claiming 0 mislabels/merges them in the Trace tab.
  const promptIndex = getPromptIndex(messages);
  let aborted = false;
  let runSucceeded = false;
  // The file-capable sandbox session, captured from `onSandboxSession` so the
  // turn-end adoption pass (in the finally, before the box is released) can read
  // `~/.claude/skills` and write the managed-skills manifest. The finally's own
  // `session` is the AI-SDK AGENT session (detach/destroy), which has no file I/O.
  let sandboxFileSession:
    | {
        readTextFile(args: { path: string }): PromiseLike<string | null>;
        writeTextFile(args: {
          path: string;
          content: string;
        }): PromiseLike<unknown>;
        run(args: {
          command: string;
        }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
      }
    | undefined;
  // WS3: the turn paused awaiting a tool approval (a third terminal alongside
  // success/abort). Treated like a clean end that happens to await input — the
  // continuation is committed with `awaitingApproval` and the next request
  // resumes it. Hoisted so the finally + onFinishEngine see it.
  let pausedForApproval = false;
  let pausedForScopeStepUp = false;
  // Internal liveness abort: the heartbeat fires this when the lease is
  // DEFINITIVELY lost (stolen/expired) or when transient heartbeat failures
  // span the lease TTL. Combined with the caller's abortSignal so either tears
  // the turn down; declared at function scope so the catch can read it.
  const livenessAbort = new AbortController();
  const effectiveAbortSignal: AbortSignal = abortSignal
    ? AbortSignal.any([abortSignal, livenessAbort.signal])
    : livenessAbort.signal;
  let usage:
    | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    | undefined;
  let turnFinishReason: FinishReason = "stop";
  // Tool calls that returned a NON-error result this turn. Read only by the
  // external-account entitlement-wall check, which must never fire on a turn
  // that actually did work — see `external-account-plan-wall.ts`.
  let successfulToolCalls = 0;
  // The runtime version this box actually installed, for adapters whose CLI is
  // not version-pinned by the package pin. Telemetry only — see the capture in
  // `onSandboxSession` and `runtimeVersionCommand` in the registry.
  let installedRuntimeVersion: string | undefined;
  let capturedTurnTrace: PersistedTurnTrace | undefined;
  // §3 atomic commit: built in executeEngine's finally (after session.detach()),
  // consumed by onFinishEngine's onConversationComplete so the resume state
  // rides /ingest-chat with the transcript. `releaseHarnessLease` lets either
  // closure free the lane if the commit can't happen (detach/persist failure).
  let capturedHarnessCommit: HarnessSessionCommitPayload | undefined;
  let releaseHarnessLease: (() => Promise<void>) | undefined;
  // Broker-delivery run identity, set after the lease is installed into E2B's
  // egress transform; used to revoke + clear the rule on teardown.
  let brokerRunId: string | undefined;
  let brokerRevoked = false;
  /**
   * The LOCAL path's own teardown: revoke the gateway, revoke the lease, stop
   * the supervised tree.
   *
   * Held out here, next to `brokerRunId`, because it has to run on EVERY
   * terminal path — normal finish, abort, and the outer catch — for the same
   * reason the broker revoke does. It is idempotent, so calling it from more
   * than one of them is harmless and is what makes each of them able to stop
   * caring which other one also ran.
   */
  let localTeardown: (() => Promise<void>) | null = null;
  // This turn's claim on the box, held across the preparation window (step 3a)
  // and given up the moment the lease is recorded — recording it consumes the
  // claim, and from then on the lease's own per-box fence is what excludes other
  // turns. True only while the claim is ours to hand back, so onFinishEngine can
  // free the box on any exit before that point instead of leaving the next turn
  // to wait out the reservation TTL.
  let reservationHeld = false;
  let releaseBoxReservation: (() => Promise<void>) | undefined;
  let reservationHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reservationRenewalInFlight = false;
  const clearReservationHeartbeat = () => {
    if (reservationHeartbeatTimer !== undefined) {
      clearInterval(reservationHeartbeatTimer);
      reservationHeartbeatTimer = undefined;
    }
  };
  // Ownership handoff for the claimed continuity lane: false from the moment the
  // lane is claimed until the harness session is established (the point the
  // finalizer/heartbeat take over). While false, ANY failure (sandbox wake,
  // broker start, runtime/agent construction, createSession) must release the
  // lane in onFinishEngine, or the next chat turn is blocked until the lease TTL.
  let sessionEstablished = false;
  // Cumulative tool spans for the turn trace, hoisted so onFinishEngine (a
  // sibling closure) can read them into PersistedTurnTrace.spans.
  const capturedSpans: EvalTraceSpan[] = [];
  // Tool calls the MCP proxy refused on this run's sealed `toolPolicy`. The
  // block happens on whichever replica served the call; it is accounted for
  // HERE — from the proxy's own correlated report, and from the result the
  // harness reports back — and handed to the caller (`onHarnessPolicyBlocks`)
  // as the same records the in-process gate produces.
  const harnessPolicyBlocks: HarnessPolicyBlockRecord[] = [];
  const flushHarnessPolicyBlocks = () => {
    if (harnessPolicyBlocks.length === 0) return;
    onHarnessPolicyBlocks?.([...harnessPolicyBlocks]);
    harnessPolicyBlocks.length = 0;
  };
  const hasHarnessToolPolicy =
    !!harnessToolPolicy && Object.keys(harnessToolPolicy).length > 0;
  // Blocks the proxy reported over the authoritative channel, and the count of
  // blocks this turn already accounted off a result. A channel event is claimed
  // by the matching result when one arrives; whatever is left at turn end is
  // still reported (the harness may never surface the refusal as a result), and
  // an already-accounted key absorbs its late channel event so one refusal
  // cannot be counted twice.
  const channelPolicyBlocks: Array<
    HarnessPolicyBlockEvent & { claimed?: boolean }
  > = [];
  const accountedPolicyBlocks = new Map<string, number>();
  const policyBlockKey = (serverId: string, toolName: string) =>
    `${serverId}\u0000${toolName}`;
  const claimChannelPolicyBlock = (
    serverId: string,
    toolName: string,
  ): HarnessPolicyBlockEvent | undefined => {
    const event = channelPolicyBlocks.find(
      (candidate) =>
        !candidate.claimed &&
        candidate.serverId === serverId &&
        candidate.toolName === toolName,
    );
    if (event) event.claimed = true;
    return event;
  };
  const noteAccountedPolicyBlock = (serverId: string, toolName: string) => {
    const key = policyBlockKey(serverId, toolName);
    accountedPolicyBlocks.set(key, (accountedPolicyBlocks.get(key) ?? 0) + 1);
  };
  /** Report channel blocks no result ever accounted for. */
  const drainUnclaimedChannelPolicyBlocks = () => {
    for (const event of channelPolicyBlocks) {
      if (event.claimed) continue;
      event.claimed = true;
      const key = policyBlockKey(event.serverId, event.toolName);
      const accounted = accountedPolicyBlocks.get(key) ?? 0;
      if (accounted > 0) {
        accountedPolicyBlocks.set(key, accounted - 1);
        continue;
      }
      harnessPolicyBlocks.push({
        toolName: event.toolName,
        reason: event.reason,
        classification: event.classification,
        at: event.at,
        serverId: event.serverId,
      });
    }
  };
  // ── Live trace emission (parity with runChatEngineLoop's writeTraceEvent) ──
  // The Trace tab is built entirely from `data-trace-event` SSE parts; the
  // harness path must emit turn_start / trace_snapshot / turn_finish or the tab
  // stays on its "Sample trace" placeholder forever. `traceTurnStarted` gates
  // the error-path finish so a pre-stream failure can't emit a phantom turn.
  // `stepStartedAt` clocks the synthetic per-step agent (llm) span — the span
  // that renders the "Agent:" row and guarantees non-empty spans even for
  // text-only turns (capturedSpans otherwise holds tool spans only).
  // `toolSetForTrace` is the harness-side stand-in for an `ai` ToolSet (there
  // is none — it drives the in-sandbox CLI via .mcp.json): a toolName→serverId
  // map so emitTraceSnapshot can attach actualToolCalls.serverId.
  // `traceBaseMs` is the zero-point for span offsets — set to STREAM start (after
  // credential/claim/box-wake/connect), not `turnStartedAt` (function entry).
  // Basing on function entry painted the per-turn setup latency as an empty gap
  // before every turn's bar; the emulated engine clocks from stream start too,
  // so this keeps the harness trace gapless and on parity. Setup time still
  // shows in the [harness][timing] phase log.
  let traceBaseMs = turnStartedAt;
  let stepStartedAt = turnStartedAt;
  const toolSetForTrace: Record<string, { _serverId?: string }> = {};
  // The shared per-turn ritual (turn_start / onStepFinish / turn_finish /
  // PersistedTurnTrace / abort). Constructed at STREAM start once `traceBaseMs`
  // is finalized; read by `onFinishEngine` (a sibling closure) for the trace.
  let driver: StreamTurnDriver | undefined;
  /**
   * Whether the model request was HANDED OVER — the boundary between our own
   * preparation and the provider's turn.
   *
   * Not `driver.traceStarted`, which was the first version of this and is set
   * far too late: the driver is only built after `agent.stream(...)` RESOLVES,
   * so an immediate provider rejection (auth, quota, a rate limit) would be
   * reported as our setup failing when the model had in fact been asked.
   *
   * Set immediately before the call instead, so the flag marks the handover
   * itself rather than a successful one.
   */
  let modelInvoked = false;

  const executeEngine = async ({ writer }: { writer: ChunkWriter }) => {
    onStreamWriterReady?.(writer);
    if (effectiveAbortSignal.aborted) {
      aborted = true;
      return;
    }
    // Harness MCP-server tools run out of process through the generated
    // `.mcp.json`. The proxy publishes an actionable scope challenge under
    // this turn's opaque id; bridge it into the same transient stream part the
    // in-process tool wrapper emits. Exact turn correlation handles concurrent
    // chats; the registry's server fallback is used only when one live turn can
    // possibly receive a stale resumed-session event.
    const observedHarnessToolCalls: ObservedHarnessToolCall[] = [];
    // HOST-EXECUTED delivery only: the RAW MCP result of a projected call,
    // captured at `execute()` time and keyed by the AI SDK `toolCallId`. The
    // relay carries the MODEL-FACING projection instead (see
    // `projectSelectedMcpServersAsHostTools`), and the runtime echoes back only
    // what it was given — so without this the UI, the trace and the transcript
    // would all see the scrubbed copy, diverging from the emulated engine,
    // which shows the raw result and projects for the model alone. Claimed once
    // per tool result and then dropped, so the map cannot outgrow the turn.
    const hostExecutedRawResults = new Map<string, unknown>();
    let pendingScopeChallenge: HarnessScopeStepUpEvent | undefined;
    let suspendedHarnessToolCallId: string | undefined;
    let scopeStepUpCreation: Promise<void> | undefined;
    const tryCreateHarnessScopeStepUp = () => {
      if (
        !pendingScopeChallenge?.toolName ||
        !createHarnessScopeStepUpContinuation ||
        scopeStepUpCreation
      ) {
        return;
      }
      const challenge = pendingScopeChallenge;
      // `toolCallId` first, tuple only when the publisher had no id to give —
      // see `matchHarnessScopeStepUpToolCall`. Two identical calls in one turn
      // otherwise resume the FIRST one, whichever raised the challenge.
      const matchingCall = matchHarnessScopeStepUpToolCall({
        observed: observedHarnessToolCalls,
        challenge,
      });
      if (!matchingCall) return;
      suspendedHarnessToolCallId = matchingCall.toolCallId;
      scopeStepUpCreation = Promise.resolve(
        createHarnessScopeStepUpContinuation({
          info: {
            ...challenge,
            toolCallId: matchingCall.toolCallId,
          },
          toolName: matchingCall.toolName,
          toolInput: matchingCall.input,
        }),
      )
        .then((event) => {
          emitScopeStepUpRequiredChunk(writer, event);
          pausedForScopeStepUp = true;
        })
        .catch((error) => {
          logger.warn("[harness-scope-step-up] continuation create failed", {
            serverId: challenge.serverId,
            error: error instanceof Error ? error.message : String(error),
          });
          emitInsufficientScopeChunk(writer, undefined, challenge);
        });
    };
    /**
     * The turn's ONE scope step-up intake, with two publishers:
     *
     *  - NATIVE delivery — the signed proxy, which saw the sandbox's own
     *    `tools/call` and publishes under this turn's correlation id
     *    (subscription below);
     *  - HOST-EXECUTED delivery — the in-process projected tools, which raise
     *    the challenge inside `execute()` and hand it straight here
     *    (`onScopeStepUpChallenge`, wired at the projection below).
     *
     * Both arrive as the same event and take the same path, so a Codex turn
     * pauses for a step-up exactly like a Claude Code turn does. Ordering
     * against the tool-call observation is handled by `tryCreate…` being called
     * from both sides — whichever lands second completes the correlation.
     */
    const receiveScopeStepUpChallenge = (info: HarnessScopeStepUpEvent) => {
      if (!harnessScopeStepUpServerMatches(selectedServers, info.serverId)) {
        return;
      }
      pendingScopeChallenge = info;
      if (!info.toolName || !createHarnessScopeStepUpContinuation) {
        emitInsufficientScopeChunk(writer, undefined, info);
        return;
      }
      tryCreateHarnessScopeStepUp();
    };
    const stopScopeStepUpBridge = harnessMcpProxy
      ? subscribeHarnessScopeStepUp(
          turnId,
          receiveScopeStepUpChallenge,
          selectedServers,
        )
      : () => {};

    // The proxy's own report of every call it refused on this run's sealed
    // policy. Authoritative (the proxy knows it blocked) and independent of what
    // the harness does to the result it hands back — which for Claude Code is to
    // flatten it to a bare string, dropping the `_meta` marker. Same shape as
    // the scope step-up bridge: correlate on this turn's opaque id, plus a poll
    // of the shared sink for the replica that served the call being another one.
    const stopPolicyBlockBridge =
      harnessMcpProxy && hasHarnessToolPolicy
        ? subscribeHarnessPolicyBlocks(
            turnId,
            (event) => {
              channelPolicyBlocks.push({ ...event });
            },
            selectedServers,
          )
        : () => {};
    const stopPolicyBlockPoll =
      harnessMcpProxy && hasHarnessToolPolicy
        ? startCrossInstanceHarnessPolicyBlockPoll(selectedServers ?? [])
        : () => {};

    // Hoisted so the catch can close an open text block if the turn fails
    // after emitting text-start.
    let textId: string | undefined;
    // True once any assistant text reached the writer this turn. If the harness
    // delivers its answer as a final result instead of streamed `text-delta`
    // parts, this stays false and we synthesize chunks from `res.text` below so
    // the Chat pane never renders a blank reply on a successful turn.
    let emittedAnyText = false;
    let emittedAnyVisiblePart = false;
    const seenHarnessPartTypes = new Set<string>();
    // Open reasoning block id (separate UI part from text). The harness emits
    // reasoning-* as a distinct block; we close it before any text/tool/finish.
    let reasoningId: string | undefined;
    const closeReasoning = () => {
      if (reasoningId !== undefined) {
        emitReasoningEnd(writer, reasoningId);
        reasoningId = undefined;
      }
    };

    try {
      if (!projectId) {
        throw new Error(
          "harness turn requires a projectId to resolve the computer",
        );
      }
      if (!authHeader) {
        throw new Error(
          "harness turn requires an auth bearer to resolve the computer",
        );
      }
      // WS3: requireToolApproval is now SUPPORTED via the harness's native
      // permissionMode (built-ins) + toolApproval (host tools) — the turn pauses
      // on a `tool-approval-request`, we surface MCPJam's approval chunk, then
      // resume with the decision. This is ONE path for all three surfaces —
      // built-ins, host-executed tools, and (for an adapter whose permission
      // mode reaches them) MCP-server tools delivered through `.mcp.json`. The
      // adapter decides which calls pause; nothing here is per-surface, which
      // is why widening Claude Code's coverage needed no change on this side.
      // The availability preflight still refuses a harness that cannot pause on
      // the surface its MCP tools actually run on — Codex, today.
      // Detect an approval-response resume up front (the inbound messages carry
      // the user's decision as trailing tool-approval-response parts); a resume
      // continues the paused turn rather than starting a new prompt.
      const approvalContinuations =
        collectHarnessAgentToolApprovalContinuations({
          messages: messages as never,
        });
      const isApprovalResume = approvalContinuations.length > 0;

      // Phase timing — log where a turn spends its wall-clock (claim / box
      // wake / broker start / session connect / model stream / finalize) so
      // "takes forever" can be attributed instead of guessed.
      const tStart = Date.now();
      let tClaim = tStart;
      let tSandbox = tStart;
      let tBroker = tStart;
      let tConnect = tStart;
      let resumedSession = false;

      // 0. Capability prechecks — BEFORE any credential/sandbox work (defense in
      // depth for eval/synthetic/unified paths that don't hit the route preflight).
      // Cheap + pure, so a misconfigured turn fails before we fetch/audit/rate-
      // limit the Gateway credential or wake the box.
      //   (a) the runtime must be able to run this model — else createX() would
      //       silently substitute its own default model.
      //       SKIPPED for an external-account harness: the model MCPJam knows
      //       about is not the model that runs. Cursor's adapter passes no
      //       model at all and Cursor Auto picks one on the customer's own
      //       account, so there is no substitution to catch here — asking
      //       `supportsModel` would only be asking the adapter to rubber-stamp
      //       a value nothing consumes.
      if (
        harnessAdapter.modelAccess !== "external-account" &&
        !harnessAdapter.supportsModel(modelId)
      ) {
        throw new Error(
          `The ${harnessAdapter.displayName} harness can't run model "${modelId}".`,
        );
      }
      //   (a2) capability/hook invariant for plugin BUNDLE install: advertising
      //       it means implementing it. No adapter does today (see the registry's
      //       `supportsPluginBundles`), so this only guards a future one from
      //       claiming a native plugin install MCPJam would then silently skip.
      if (
        harnessAdapter.supportsPluginBundles &&
        !harnessAdapter.deliverPluginBundles
      ) {
        throw new Error(
          `The ${harnessAdapter.displayName} harness advertises plugin-bundle ` +
            "support but has no deliverPluginBundles strategy (adapter misconfigured).",
        );
      }
      //   (b) approval invariant (advertise = enforce). The route pre-flight
      //       already refuses every unsound approval combination; the eval,
      //       synthetic and unified paths never call it, which is exactly what
      //       this backstops. It asks the SAME helper the pre-flight asks, so
      //       the two can't drift — and it is deliberately NOT conditioned on
      //       there being selected servers: a runtime that can't pause on its
      //       own native tools (Codex) is unsound under approval whether or not
      //       any MCP server is attached, and its host-executed built-ins
      //       (web_search) would otherwise run unapproved here.
      const approvalRefusal = harnessToolApprovalRefusalReason({
        adapter: harnessAdapter,
        requireToolApproval,
        hasSelectedMcpServers: (selectedServers?.length ?? 0) > 0,
      });
      if (approvalRefusal) {
        throw new Error(`Can't run this turn: ${approvalRefusal}.`);
      }

      // 1. Credential delivery gate. BROKER-ONLY (COMP-23): the lease is
      // installed into E2B's egress transform AFTER the sandbox id is known
      // (step 3b) and the CLI runs with dummy creds — the inspector never
      // holds a model credential. The raw-key client path (resolveAuth →
      // /web/harness/model-credential) was removed because it spent the
      // system AI Gateway key with zero metering. With the kill switch off,
      // EVERY scope fails closed here (guests were already broker-only —
      // this now covers members too); the chat-v2 routes surface the same
      // condition pre-stream via checkHarnessRuntimeAvailable.
      //
      // An EXTERNAL-ACCOUNT harness is exempt, and not as a favour: it has no
      // broker to disable. Its credential is the customer's own materialized
      // project secret and its model traffic never touches MCPJam's proxy, so
      // refusing it here would be switching off a path it never uses.
      if (
        harnessAdapter.modelAccess !== "external-account" &&
        !harnessBrokerDeliveryEnabled()
      ) {
        throw new Error(
          "Harness runs require broker credential delivery, but it is " +
            "disabled on this server (MCPJAM_HARNESS_BROKER_DELIVERY=false). " +
            "There is no fallback credential path — re-enable the broker to " +
            "run harness turns.",
        );
      }

      // 2. Build the .mcp.json — always-proxy: ensure a per-server tunnel and
      // point every entry at MCPJam's own adapter-http (no upstream creds in the
      // box). Done BEFORE waking the computer so a tunnel/grant failure doesn't
      // provision (or bump activity on) the box only to fail.
      //
      // Progressive tool discovery (progressivePlan / discoveryState) is
      // intentionally NOT applied here. It is an EMULATED-engine mechanism:
      // runChatEngineLoop injects MCPJam's meta-tools (search_mcp_tools, …) and
      // narrows the advertised tool catalog per step to mimic how a host lazily
      // reveals tools. In harness mode the REAL Claude Code runs its own native
      // tool discovery from the .mcp.json (the CLI's real progressiveToolDiscovery
      // behavior), so we attach the full selected-server set and let the runtime
      // own discovery. Re-applying the emulation would double it, defeat the
      // "observe the real runtime" purpose, and isn't expressible anyway —
      // .mcp.json has no knob to inject MCPJam meta-tools into the real loop.
      // Which of the two delivery modes this adapter uses. Mutually exclusive
      // by construction (`HarnessMcpDelivery`), so the model can never see the
      // same MCP tool twice.
      const nativeMcpDelivery = harnessAdapter.mcpDelivery === "native";
      // Fail closed: with MCP servers selected but no plane strategy, a NATIVE
      // adapter would silently get zero MCP tools (the exact failure we hit).
      // Host-executed delivery needs no proxy at all — its tools run in THIS
      // process against the already-authorized manager — so requiring a
      // strategy there would refuse a turn that has everything it needs.
      if (
        nativeMcpDelivery &&
        (selectedServers?.length ?? 0) > 0 &&
        !harnessMcpProxy
      ) {
        throw new Error(
          "harness turn has MCP servers but no harnessMcpProxy strategy — the caller route must set options.harnessMcpProxy",
        );
      }
      const pluginServerOrigins = effectiveCapabilities
        ? pluginOriginByServerId(effectiveCapabilities)
        : undefined;
      const proxyConfig = nativeMcpDelivery
        ? await buildHarnessProxyMcpJsonFromManager({
            manager: mcpClientManager,
            selectedServerIds: selectedServers ?? [],
            authHeader,
            projectId,
            strategy: harnessMcpProxy ?? { plane: "local-mcp" },
            scopeStepUpCorrelationId: turnId,
            // The SAME per-turn id the scope-step-up correlation uses. It is
            // already minted fresh for every turn attempt, which is exactly
            // what evidence needs: a retry or resume files its calls under a
            // new turn, so a stale attempt's rows stay addressable but out of
            // the current turn's completeness check.
            ...(evalIterationId
              ? { evidenceScope: { iterationId: evalIterationId, turnId } }
              : {}),
            // Policied servers get a SEALED token instead of a bare one, so
            // the sandbox's own MCP calls are enforced at the proxy.
            ...(harnessToolPolicy ? { toolPolicy: harnessToolPolicy } : {}),
            // INS-7: plugin-contributed servers ride this SAME proxy path as
            // ordinary server ids (they are ordinary server ids) — the origin
            // map only decides how a delivery failure is reported.
            ...(pluginServerOrigins
              ? { pluginOrigins: pluginServerOrigins }
              : {}),
          })
        : { mcpJson: { mcpServers: {} }, keyToServerId: {} };
      const { mcpJson, keyToServerId } = proxyConfig;

      // Report the run's frozen decision as the mint saw it. The driver reads
      // this to decide whether to read evidence for the turn at all — and it
      // is a REPORT: a turn cannot turn capture on, only observe what the run
      // froze at creation.
      if (onHarnessEvidenceDecision) {
        const decision = (
          proxyConfig as { harnessEvidence?: HarnessEvidenceDecision }
        ).harnessEvidence;
        if (decision) {
          onHarnessEvidenceDecision({ ...decision, turnId });
        }
      }

      // HOST-EXECUTED delivery (COMP-39): the runtime can't make an MCP tool
      // model-callable, so MCPJam enumerates each selected server's tools NOW
      // and hands them to the agent as host-executed tools named exactly as
      // Claude Code names them (`mcp__<key>__<tool>`). Enumerated once, at turn
      // start — there is no `tools/list_changed` subscription, so a mid-turn
      // schema change is only picked up on the next turn. Done here, before the
      // box is woken, so an unreachable server fails the turn cheaply.
      const hostExecutedMcp =
        !nativeMcpDelivery && (selectedServers?.length ?? 0) > 0
          ? await projectSelectedMcpServersAsHostTools({
              manager: mcpClientManager,
              selectedServerIds: selectedServers ?? [],
              ...(pluginServerOrigins
                ? { pluginOrigins: pluginServerOrigins }
                : {}),
              // No proxy on this path, so the run's `toolPolicy` is enforced
              // IN-PROCESS instead of by a sealed proxy token — same decision
              // function, same block envelope.
              ...(harnessToolPolicy ? { toolPolicy: harnessToolPolicy } : {}),
              // …and, for the same reason, no proxy to extract a SEP-2350
              // challenge either. Publish straight into the turn's step-up
              // intake so a hosted-OAuth server pauses this turn instead of
              // reporting an ordinary tool failure to the model.
              onScopeStepUpChallenge: receiveScopeStepUpChallenge,
              // The relay carries the MODEL-FACING projection of each result;
              // keep the raw one for the UI/trace/transcript so a Codex turn
              // shows what the server returned, like every other engine.
              onRawResult: ({ toolCallId, raw }) => {
                hostExecutedRawResults.set(toolCallId, raw);
              },
              // The host's own tool-CONSTRUCTION inputs. Everything the
              // emulated engine derives for `getToolsForAiSdk` lands here too,
              // via the same shared builder — this projection is the host's
              // MCP tool set for a Codex turn, so a policy that changes how a
              // tool is built has to reach it or it does not exist on this
              // delivery mode at all. (`needsApproval` is intentionally not in
              // this set — see `projectSelectedMcpServersAsHostTools`.)
              toolOptions: {
                modelVisibleMcpToolResults,
                includeAppOnly: respectToolVisibility === false,
                tasks,
              },
            })
          : { tools: {}, keyToServerId: {} };
      // The attribution map is whichever mode produced one; they are the same
      // shape and the same sanitize+dedup, so `parseToolName` is identical.
      const harnessKeyToServerId = nativeMcpDelivery
        ? keyToServerId
        : hostExecutedMcp.keyToServerId;

      // 2b. Claim the harness session lane (multi-turn continuity). Done BEFORE
      // waking the box so a "turn already running" (409) doesn't provision it.
      // Continuity needs a chat owner (chatSessionId + auth + a supported
      // ownerType); eval/synthetic harness turns (streamSink "none", no
      // chatSessionId, or eval/sandbox sourceType) run fresh with no lane.
      // Runtime skills (Convex source of truth) feed BOTH the harness `skills`
      // param (the adapter writes them in-sandbox) and resume invalidation (a
      // skill change must force a fresh session so the adapter re-writes them).
      // TRI-STATE: a fetch FAILURE must never read as "zero skills" — `skillsHash`
      // stays `undefined` so it is OMITTED from claim/commit, and the backend
      // reuses the stored hash (no resume churn, no empty-hash commit). The skills
      // fingerprint is tracked SEPARATELY from `runtimeFingerprint` precisely so
      // "unknown" (failure) is distinguishable from "" (empty project).
      // OVERRIDING MODES (see `selectHarnessSkillSource` for the precedence):
      // `pinned` (eval/swarm frozen artifacts) and `environment` (a Project
      // Environment's resolved artifacts) each supply the authoritative set —
      // even EMPTY — so the live skills query is SKIPPED entirely and
      // `skillsHash` derives from the supplied artifacts. Legacy callers
      // (neither present) keep the live tri-state fetch unchanged.
      const skillSource = selectHarnessSkillSource({
        pinnedHarnessSkills,
        runtimeSkillsOverride,
      });
      const skillsArePinned = skillSource.mode === "pinned";
      const skillsFetch =
        skillSource.mode !== "live"
          ? { ok: true as const, skills: skillSource.skills }
          : projectId && authHeader
          ? await fetchRuntimeSkills(authHeader, projectId, executionScope)
          : { ok: true as const, skills: [] };
      const runtimeSkills = skillsFetch.ok ? skillsFetch.skills : null;
      const skillsHash =
        runtimeSkills !== null ? skillsFingerprint(runtimeSkills) : undefined;

      // MATERIALIZED PROJECT SECRETS, taken from the CALLER — never fetched
      // here, and the difference is load-bearing rather than a wiring detail.
      //
      // Delivering a value into the box and SCRUBBING it out of the transcript
      // are two uses of one list, and they have to come from one read. The
      // persist callback is built by the caller (`web-chat-turn` /
      // `chat-v2`), so only the caller can hand the scrubber to it — a turn
      // that fetched its own secrets here would put them in the box and then
      // persist them verbatim, which is strictly worse than delivering none.
      //
      // So a caller that has not wired secrets delivers none. Fail-closed and
      // visible: the env bag is empty and the runtime fingerprint omits the
      // dimension entirely, so those sessions keep resuming exactly as before.
      //
      // Brokered secrets are NOT here and never will be: their values reach the
      // box through E2B's egress proxy, outside this process entirely.
      const runtimeSecrets = runtimeSecretsOverride ?? null;
      const secretEnv = runtimeSecrets
        ? toSecretEnv(runtimeSecrets)
        : undefined;

      // EXTERNAL-ACCOUNT CREDENTIAL. A harness that authenticates on the
      // customer's own provider account takes its credential from the project's
      // secrets — there is no broker lease to mint, so this is the only place
      // the value can come from.
      //
      // TWO DELIVERIES, and the second is what makes hosted evals and swarms
      // possible at all:
      //
      //   MATERIALIZED — the plaintext is in `secretEnv` above and goes to the
      //     adapter directly. Unchanged.
      //   BROKERED — the plaintext never enters this process or the box. The
      //     backend composes the secret into the box's E2B egress transform;
      //     the adapter gets a PLACEHOLDER so the CLI has something to send,
      //     and the proxy overwrites the header outside the VM.
      //
      // Eval and swarm runs REFUSE an environment that selects materialized
      // secrets (`evalSandboxes.ts`, `journeyRuns.ts`) because only the chat
      // path injects them — so before brokered delivery existed here, a Cursor
      // host could not run on those surfaces in either configuration.
      //
      // Resolved HERE, before the sandbox provider is built, for two reasons:
      // an unsatisfiable credential must fail the turn before anything is
      // provisioned, and a materialized credential has to be REMOVED from the
      // box's session env bag that the provider is about to be constructed
      // with.
      //
      // What that removal does and does not buy on the MATERIALIZED arm: the
      // key no longer rides on every `run`/`spawn` in the box, so an unrelated
      // command the agent shells out to cannot read it out of its own
      // environment. The runtime process itself still receives it — it has to,
      // that is how the CLI authenticates. The BROKERED arm has no such
      // residue: the box never holds the value at any point.
      const externalAccountCredentialNames =
        harnessAdapter.modelAccess === "external-account"
          ? harnessAdapter.externalAccountCredentialEnv
          : undefined;
      let externalAccountPlan: ExternalAccountCredentialPlan | undefined;
      if (externalAccountCredentialNames) {
        // Ask about brokered delivery ONLY for the names materialized delivery
        // did not already satisfy. A project that materializes its key pays no
        // round trip and cannot be refused by a secrets-service blip — the
        // pre-existing behaviour, preserved exactly.
        const brokerBinding = harnessAdapter.externalAccountBrokerBinding;
        const unresolved = externalAccountCredentialNames.filter(
          (name) => !secretEnv?.[name] && brokerBinding?.[name],
        );
        // The box kind is decided by the CALLER's binding (see step 3 below),
        // and it is known here because `harnessSandboxBinding` arrives on the
        // options. It matters: `projectSecretsEgress.listBrokeredSecretsForBox`
        // answers `[]` for anything without a `sandboxRowId` — persistent
        // computers receive no brokered secrets in v1 — so a chat turn on a
        // project computer must never be told its credential is brokered.
        //
        // `environmentId` is the OTHER half of that question, and the reason it
        // is threaded all the way down here rather than approximated: the
        // backend composes a box's egress transform from the ENVIRONMENT's
        // `secretSelection`, so a correctly bound brokered row the run's
        // environment does not select is never delivered. Asking project-wide
        // would report it available and start a turn that provisions a box and
        // then fails vendor auth against a placeholder.
        const brokered =
          unresolved.length > 0 && brokerBinding
            ? await fetchBrokeredCredentialNames({
                ...(authHeader ? { bearer: authHeader } : {}),
                ...(projectId ? { projectId } : {}),
                ...(environmentId ? { environmentId } : {}),
                // Copy only — an environment this process cannot name is one
                // whose selection it cannot check, so the answer is the same
                // either way and only the refusal wording changes.
                ...(!environmentId && environmentUnresolvedReason
                  ? { environmentUnresolvedReason }
                  : {}),
                boxKind: harnessSandboxBinding ? "sandbox" : "computer",
                required: Object.fromEntries(
                  unresolved.map((name) => [name, brokerBinding[name]!]),
                ),
              })
            : {
                available: new Set<string>(),
                misboundHosts: {},
                unselected: new Set<string>(),
                environmentMissing: false,
              };
        // THROWS on an unsatisfiable credential, with copy that names the
        // variable, BOTH deliveries, and where to set them. Never defaulted or
        // silently skipped — starting the CLI with no credential produces an
        // opaque failure from inside the box instead.
        //
        // KNOWN LIMITATION on the MATERIALIZED arm, and this is where it
        // surfaces: callers that do NOT wire secrets deliver none (see the note
        // on `runtimeSecrets` above — that is the documented contract, not an
        // oversight). The SYNTHETIC path (`sessionSimulation/runner.ts`, which
        // drives scenario/swarm/eval turns through `runUnifiedAssistantTurn`)
        // is one of them. Those are exactly the surfaces that refuse
        // materialized secrets anyway, so the answer for them is brokered
        // delivery rather than wiring materialized secrets into a runner that
        // has no scrubber to pair them with.
        externalAccountPlan = planExternalAccountCredentials({
          harnessDisplayName: harnessAdapter.displayName,
          required: externalAccountCredentialNames,
          secretEnv,
          brokerBinding,
          brokeredAvailable: brokered ? brokered.available : null,
          ...(brokered
            ? {
                misboundHosts: brokered.misboundHosts,
                unselected: brokered.unselected,
                environmentMissing: brokered.environmentMissing,
                ...(brokered.environmentUnresolvedReason
                  ? {
                      environmentUnresolvedReason:
                        brokered.environmentUnresolvedReason,
                    }
                  : {}),
              }
            : {}),
        });
      }
      const externalAccountAuth = externalAccountPlan?.auth;
      // What the BOX's session env carries: everything the project materialized
      // MINUS the credentials handed to the adapter directly (see above). An
      // empty result is treated exactly like "no secrets" by the provider
      // construction below. Filtering the full REQUIRED list, not just the
      // materialized arm: on the brokered arm the name is absent from
      // `secretEnv` anyway, so this is a no-op there and cannot drift.
      const sessionSecretEnv = externalAccountCredentialNames
        ? Object.fromEntries(
            Object.entries(secretEnv ?? {}).filter(
              ([name]) => !externalAccountCredentialNames.includes(name),
            ),
          )
        : secretEnv;
      // What the ADAPTER will actually write, per its own rules (Codex rejects
      // a name outright — mid-`doStart`, i.e. it would fail the whole turn — so
      // it filters rather than throws). Every MCPJam-side skill pass below is
      // driven off `delivered`, so none of them ever targets a dir the runtime
      // will not create.
      const preparedSkills =
        harnessAdapter.supportsSkills && runtimeSkills !== null
          ? harnessAdapter.prepareSkills(runtimeSkills)
          : undefined;
      const deliveredSkills = preparedSkills?.delivered ?? [];
      const deliveredSkillNamesById = new Map(
        deliveredSkills.map((s) => [s.skillId, s.name]),
      );

      // WS3: gate side-effecting built-ins (Bash/Edit/Write) behind approval
      // when the host requires it, via the adapter's declared approval mode
      // (Claude Code: allow-edits — reads stay free, the closest faithful
      // mapping to the emulated engine, which gates tool CALLS, never reads).
      // The adapter's default otherwise. Computed BEFORE the fingerprint:
      // flipping approval mode must fork the session (a resumed thread keeps
      // the mode it was created with).
      //
      // A LOCAL turn takes its mode from the CONSENTED PROFILE, not from the
      // adapter default. Claude Code's default is `allow-all`; the profiles a
      // user can actually agree to map to `allow-reads` and `allow-edits`. So
      // consenting to "read-only" and getting an agent built at `allow-all` was
      // an authorization bypass of the exact promise the consent sheet makes —
      // and because the fingerprint is computed from this value, two different
      // profiles hashed the same and a profile change resumed the old session
      // at the old breadth instead of forking.
      //
      // Resolved here, before the fingerprint, from the same manifest mapping
      // `prepareLocalHarnessTurn` uses; the two are reconciled below once
      // preparation has run.
      const localPermissionMode =
        harnessExecutionTarget != null
          ? localPermissionModeFor(
              harnessAdapter.id,
              harnessExecutionTarget.permissionProfile,
              harnessExecutionTarget.kind,
            )
          : null;
      const permissionMode: HarnessV1PermissionMode =
        harnessExecutionTarget != null
          ? // A host asking for approval narrows further: `allow-reads` is the
            // only mode under which tool calls pause. An unresolvable profile
            // falls to the NARROWEST mode rather than the adapter's default —
            // the turn is refused moments later in preparation, and until then
            // it must not be the widest thing on the menu.
            requireToolApproval || localPermissionMode === null
            ? "allow-reads"
            : localPermissionMode
          : requireToolApproval && harnessAdapter.supportsNativeToolApproval
            ? harnessAdapter.approvalPermissionMode
            : harnessAdapter.defaultPermissionMode;

      const runtimeFingerprint = harnessRuntimeFingerprint({
        harnessId: harnessAdapter.id,
        modelId,
        selectedServers: selectedServers ?? [],
        permissionMode,
        // INS-7: fold the plugin runtime in, so a version upgrade / bundle
        // change forks the session instead of resuming onto a sandbox that
        // still holds the previously delivered plugin material.
        ...(effectiveCapabilities
          ? { pluginVersions: effectiveCapabilities.pluginVersions }
          : {}),
        // ROTATION FORKS THE SESSION. A resumed harness session reattaches to a
        // bridge process that already holds its environment — the exact failure
        // the `ANTHROPIC_BASE_URL` compat bump above was minted for — so a
        // rotated value delivered without forking would land everywhere except
        // the conversation the user is sitting in.
        //
        // A caller that delivered no secrets omits the dimension rather than
        // sending `""`: omitting leaves the fingerprint exactly where it was
        // and the session resumes, while an empty value would read as "the
        // secrets were removed" and cold-start the conversation.
        //
        // A caller that could not FIND OUT is the third case, and it must not
        // be treated as either. Resuming would reattach to a bridge that may
        // still hold previously delivered values — which this turn cannot
        // enumerate, and therefore cannot scrub out of the transcript. A
        // sentinel forks instead: the fresh bridge holds nothing, so there is
        // nothing left to leak. It is a CONSTANT on purpose — two consecutive
        // failed turns share it and resume onto each other, which is right,
        // because neither delivered anything either.
        ...(secretsUnavailable
          ? { secretsHash: "unavailable" }
          : runtimeSecrets !== null
          ? { secretsHash: deliveredSecretsFingerprint(runtimeSecrets) }
          : {}),
        // Two Codex transports share this harness id and are not
        // resume-compatible; see the field's note. Absent or `"exec"` hashes
        // exactly as before, so no existing session forks on deploy.
        ...(harnessAdapter.transport
          ? { transport: harnessAdapter.transport }
          : {}),
        // WHERE, and on exactly what. A hosted turn omits this entirely and
        // keeps hashing as it always did.
        ...(harnessExecutionTarget
          ? {
              localTarget: {
                runtimeId: harnessExecutionTarget.runtimeId,
                workspaceGrantId: harnessExecutionTarget.workspaceGrantId,
                policyVersion: harnessExecutionTarget.policyVersion,
                permissionProfile: harnessExecutionTarget.permissionProfile,
              },
            }
          : {}),
      });
      const ownerType: HarnessOwnerRef["ownerType"] | undefined =
        sourceType === "scenario"
          ? "scenario-chat"
          : sourceType === "swarm"
          ? "swarm-chat"
          : sourceType === "eval" || sourceType === "sandbox"
          ? undefined
          : "direct-chat";
      // FAIL CLOSED on incomplete swarm continuity identity. The `swarm-chat`
      // lane is keyed on (journeyRunId, hostId, chatSessionId); if the swarm
      // runner reached a harness turn without ALL of them, silently skipping
      // continuity would run a fresh un-keyed session — losing multi-turn
      // resume AND emitting a transcript whose harness sidecar can't be
      // attributed to its run. That's a runner wiring bug; surface it.
      if (
        ownerType === "swarm-chat" &&
        !(journeyRunId && hostId && chatSessionId)
      ) {
        throw new Error(
          "Swarm harness turn is missing continuity identity " +
            "(journeyRunId, hostId, and chatSessionId are all required for " +
            "the swarm-chat owner lane)",
        );
      }
      let continuity:
        | {
            owner: HarnessOwnerRef;
            leaseId: string;
            stateVersion: number;
            state: {
              harnessSessionId: string;
              resumeState: unknown;
              computerId: string;
              awaitingApproval?: boolean;
            } | null;
          }
        | undefined;
      if (
        chatSessionId &&
        projectId &&
        authHeader &&
        ownerType &&
        (ownerType !== "scenario-chat" || scenarioId) &&
        // swarm-chat completeness is enforced (throw) above, so reaching here
        // with ownerType === "swarm-chat" implies all three key dimensions.
        (ownerType !== "swarm-chat" || (journeyRunId && hostId))
      ) {
        const owner: HarnessOwnerRef = {
          projectId,
          // Lane key dimension: a Codex turn and a Claude Code turn for the same
          // chat occupy SEPARATE lanes, so neither can resume the other's
          // sidecar. The backend keys (projectId, harnessId, ownerType, ownerKey).
          harnessId: harnessAdapter.id,
          ownerType,
          chatSessionId,
          ...(scenarioId ? { scenarioId } : {}),
          // Swarm continuity lane — the run + pinned host key the owner so a
          // multi-turn swarm harness session resumes ONLY its own sidecar.
          ...(ownerType === "swarm-chat" && journeyRunId
            ? { journeyRunId }
            : {}),
          ...(ownerType === "swarm-chat" && hostId ? { hostId } : {}),
          // Phase 3: route owner resolution through resolveExecutionAccess so a
          // host-funded swarm guest can claim/resume their OWN lane.
          ...(executionScope ? { executionScope } : {}),
        };
        const leaseId = crypto.randomUUID();
        const claim = await claimHarnessSessionState({
          owner,
          runtimeFingerprint,
          ...(skillsHash !== undefined ? { skillsHash } : {}),
          leaseId,
          leasedBy: `${HARNESS_INSTANCE_ID}:${turnId}`,
          leaseTtlMs: HARNESS_LEASE_TTL_MS,
          bearer: authHeader,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!claim.ok) {
          // FAIL CLOSED for chat-backed owners (this block only runs for
          // direct-chat/scenario-chat). Never silently start a fresh,
          // non-persisted harness session when continuity can't be guaranteed —
          // that would mislead the user into thinking they're in a continuous
          // conversation.
          if (claim.status === 409) {
            throw new Error(
              "Another turn is already running for this chat — wait for it to finish.",
            );
          }
          logger.warn("[harness] session-state claim failed; failing closed", {
            status: claim.status,
            error: claim.error,
          });
          throw new Error(
            `Couldn't start a ${harnessAdapter.displayName} session — the ` +
              "continuity service is unavailable right now. Please try again in " +
              "a moment.",
          );
        } else {
          continuity = {
            owner,
            leaseId,
            stateVersion: claim.stateVersion,
            // A runtime-fingerprint change (model / server set / SKILLS) MUST
            // yield no resumable state, so the adapter re-writes skills on a
            // fresh start (it skips writes on resume). Enforce here rather than
            // trusting the endpoint to null `state` on mismatch.
            state: claim.fingerprintChanged ? null : claim.state,
          };
          // Bounded: every caller of this is on the terminal path, and a
          // stalled release would hold the turn open exactly like the broker
          // revoke did. A missed release is recovered by the lane's lease TTL.
          releaseHarnessLease = () =>
            releaseHarnessSessionState({
              owner,
              leaseId,
              bearer: authHeader,
              signal: AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
            }).catch(() => {});
        }
      }
      tClaim = Date.now();

      // 3. Get the box this turn runs on. TWO paths, and the choice is made by
      //    the CALLER, never inferred here:
      //
      //    EPHEMERAL (`harnessSandboxBinding`, B-isolation phase 6) — the caller
      //    already provisioned a per-attempt disposable box and hands it over.
      //    Nothing is reserved, nothing is woken: the box exists, is live, and
      //    belongs to this session alone. A swarm session takes this path.
      //
      //    PERSONAL (no binding) — reserve and wake the acting user's project
      //    computer, exactly as playground/chat/evals always have.
      //
      //    The binding arrives OUT OF BAND, on the handler options, mirroring
      //    `ctx.sandboxBinding` on the bash path: it is only settable by an
      //    in-process caller that just provisioned. It is deliberately NOT part
      //    of any host config or run snapshot, so nothing parsed off the wire
      //    can point a harness at a box it does not own.
      //
      //    `box` is the CONTROL-PLANE identity the broker leases against and the
      //    continuity lane keys its resume on; `sandboxId` is the vendor id the
      //    runtime connects to. On the personal path the first is a
      //    `projectComputers` id, on the ephemeral path an `evalSandboxes` row
      //    id — distinct id spaces, so a resumed lane can never mistake one for
      //    the other.
      // 3-LOCAL. The user's own machine, which takes NONE of the cloud path
      // below: no box to reserve, none to wake, no egress transform to install,
      // and a lease bound to an installation rather than a computer.
      //
      // Prepared in one call (`prepareLocalHarnessTurn`) rather than as a
      // conditional inside each cloud step, because every one of those steps
      // has a local answer that is not "the same thing with a flag" — and
      // interleaving them would leave neither path legible.
      //
      // A refusal here is FINAL. It is not degraded to a hosted turn: silently
      // relocating work the user deliberately scoped to their machine is the
      // dishonesty this design exists to remove, so the message says what
      // failed and the caller decides.
      let localPrepared: PreparedLocalHarnessTurn | null = null;
      if (harnessExecutionTarget) {
        // Its own run id rather than the cloud path's `turnRunId`, which is
        // minted further down for the broker's revoke key. The local lease is
        // revoked by THIS id, and the two paths never both hold one.
        const localRunId = crypto.randomUUID();
        const preparation = await prepareLocalHarnessTurn({
          target: harnessExecutionTarget,
          harnessId: harnessAdapter.id,
          modelId,
          sessionId: `local-${localRunId}`,
          runId: localRunId,
          actor: {
            isGuest: false,
            isScenarioSession: Boolean(scenarioId),
            isJourneySession: Boolean(journeyRunId),
            ...(executionScope?.kind === "swarm"
              ? { executionScopeKind: "swarm" as const }
              : {}),
          },
          projectId,
          bearer: authHeader,
          requireToolApproval,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!preparation.ok) {
          throw new Error(
            `Can't run this turn on your machine (${preparation.status}): ` +
              preparation.message,
          );
        }
        localPrepared = preparation.prepared;
        localTeardown = preparation.prepared.teardown;
        // The mode the agent was already built around, against the mode the
        // prepared plan actually launched under. They come from the same
        // manifest mapping and should be identical; if they ever are not, the
        // agent is enforcing something other than what the user consented to
        // and the only safe answer is to stop. Cheap, and it is the assertion
        // that keeps the split between "resolved early for the fingerprint"
        // and "resolved during preparation" honest.
        if (localPrepared.permissionMode !== permissionMode) {
          throw new Error(
            `Can't run this turn on your machine: the consented permission ` +
              `profile resolves to ${localPrepared.permissionMode} but the ` +
              `agent was configured for ${permissionMode}.`,
          );
        }
      }

      let box: HarnessBrokerBox | null = null;
      let sandboxId: string | null = null;
      if (localPrepared !== null) {
        // No box exists. Both stay null, and every cloud step below is guarded
        // on that rather than on the option — so a future caller that sets the
        // target without going through the preparation cannot half-run the
        // cloud path.
      } else if (harnessSandboxBinding) {
        box = {
          kind: "sandbox",
          sandboxRowId: harnessSandboxBinding.sandboxRowId,
        };
        sandboxId = harnessSandboxBinding.sandboxId;
      } else {
        const resolved = await resolveHarnessSandbox({
          bearer: authHeader,
          projectId,
          ...(executionScope ? { executionScope } : {}),
          signal: abortSignal,
        });
        box = {
          kind: "computer",
          computerId: String(resolved.computerId),
          projectId,
          ...(executionScope ? { executionScope } : {}),
        };
        sandboxId = resolved.sandboxId;
      }
      // The box's control-plane id as a plain string — what the resume
      // eligibility check compares and what the sidecar commit persists. Named
      // `computerId` because that is the field name on the persisted state and
      // in the session-state wire contract; broadening that contract to say
      // "box id" is a cross-repo rename with no behavioural gain, and the two
      // id spaces cannot collide.
      //
      // On the LOCAL path there is no box, so the continuity lane keys on the
      // installation and the runtime instead: `<machineId>:<runtimeId>`. That
      // is the right identity for the same reason a box id is on the cloud
      // path — it is what a resumed session must still be attached to — and it
      // cannot collide with either id space, both of which are Convex row ids
      // with no colon in them.
      const computerId =
        localPrepared !== null
          ? `${harnessExecutionTarget!.machineId}:${localPrepared.plan.runtime.runtimeId}`
          : box!.kind === "computer"
            ? box!.computerId
            : box!.sandboxRowId;
      // The id the CUMULATIVE-UPLOAD QUOTA is metered against — a real
      // `projectComputers` row, or nothing.
      //
      // Deliberately not `computerId` above. That one is a BOX identity and is
      // an `evalSandboxes` row id on the ephemeral path; handing it to
      // `/computers/upload/reserve` looks up a computer that does not exist,
      // and the non-413 branch there fails OPEN — so every write would skip
      // quota accounting silently while still paying for an on-box size sweep.
      // Omitting it is also the RIGHT answer, not just the safe one: the quota
      // bounds what accumulates on a persistent machine, and an ephemeral box
      // is deleted with its attempt. The per-turn `MATERIALIZE_BUDGET_BYTES`
      // still bounds the write either way.
      const uploadQuotaComputerId =
        box !== null && box.kind === "computer" ? box.computerId : undefined;
      tSandbox = Date.now();

      // 3a. RESERVE the box, then start the baseline-preserving broker lease.
      //
      // The harness runtime is installed into the sandbox by a bootstrap recipe
      // that shells `pnpm install` for the agent CLI. The lease keeps the box's
      // own egress baseline (public internet for members; web-only for guests)
      // and only adds a header transform on the model-proxy host, so the
      // in-stream bootstrap can reach the package registry on its own. The
      // reservation is a concurrency/liveness control — it is NOT an egress
      // lock — and is kept on its own merits pending an independent removal
      // gate.
      //
      // ONE id for the whole turn: it names this turn's claim on the box, and
      // the lease consumes that claim by matching it. Deliberately NOT assigned
      // to `brokerRunId` yet — that variable means "a lease may exist under this
      // id", and teardown reads it to decide whether to revoke. Setting it here
      // would make every failed preparation issue a pointless revoke for a lease
      // that was never minted.
      const turnRunId = crypto.randomUUID();

      // Claim the box for the whole preparation window. The lease's own per-box
      // fence starts only once a lease exists, so without this two turns could
      // interleave wake / bootstrap / broker-start. A refusal here is the same
      // condition a caller would otherwise meet at broker start, just detected
      // before we do any work.
      const reservation = await reserveHarnessBox({
        box: box!,
        harnessId: harnessAdapter.id,
        modelId,
        runId: turnRunId,
        bearer: authHeader,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      if (!reservation.ok) {
        throw new Error(reservation.error);
      }
      // From here until the lease is minted, ANY exit must hand the box back —
      // otherwise the next turn waits out the reservation's TTL for nothing.
      // Cleared once the broker start succeeds, because recording the lease
      // consumes the claim and the lease's own fence takes over.
      reservationHeld = true;
      releaseBoxReservation = async () => {
        await releaseHarnessBoxReservation({
          box: box!,
          harnessId: harnessAdapter.id,
          modelId,
          runId: turnRunId,
          bearer: authHeader,
          signal: AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
        }).catch(() => {});
      };
      reservationHeartbeatTimer = setInterval(() => {
        if (!reservationHeld || reservationRenewalInFlight) return;
        reservationRenewalInFlight = true;
        void renewHarnessBoxReservation({
          box: box!,
          harnessId: harnessAdapter.id,
          modelId,
          runId: turnRunId,
          bearer: authHeader,
          signal: AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
        })
          .then((renewed) => {
            if (!renewed.ok && reservationHeld) {
              logger.error(
                "[harness] preparation reservation was lost; aborting the turn",
              );
              livenessAbort.abort(new Error("harness box reservation lost"));
            }
          })
          .catch((err) => {
            if (reservationHeld) {
              logger.error(
                "[harness] preparation reservation renewal failed; aborting the turn",
                err,
              );
              livenessAbort.abort(new Error("harness box reservation lost"));
            }
          })
          .finally(() => {
            reservationRenewalInFlight = false;
          });
      }, HARNESS_RESERVATION_HEARTBEAT_MS);

      // Root the Shell at the host-configured working directory (COMP-16) — the
      // same `computer.workdir` the chat bash tool honors — confined under
      // /home/user, defaulting to the box home. The harness framework nests a
      // per-session `<workdir>/claude-code-<sessionId>` dir beneath it, so both
      // planes share one configured root even though the Shell gets its own
      // session subdir. An escaping value falls back to the default rather than
      // failing the turn (the UI + bash path already reject escapes loudly).
      // On the ephemeral path the workdir comes back WITH the box: the control
      // plane resolved it from the same pinned target spec when it reserved the
      // row, so it is the authoritative value for THIS box. Falling through to
      // `computerWorkdir` keeps the personal path identical. Both still go
      // through `resolveWorkingDirectory`, so neither can escape /home/user.
      const resolvedHarnessWorkdir = resolveWorkingDirectory(
        harnessSandboxBinding?.workdir ?? computerWorkdir,
      );
      const defaultWorkingDirectory =
        "error" in resolvedHarnessWorkdir
          ? HOME_ROOT
          : resolvedHarnessWorkdir.workdir ?? HOME_ROOT;
      // ONE provider for the turn: the streaming session below attaches to the
      // box through it. One provider per turn is still the right shape even
      // without a separate prewarm pass.
      // On the LOCAL path the provider was already built by
      // `prepareLocalHarnessTurn`: it supervises a real process tree on this
      // machine, so there is no sandbox id to attach to and nothing to
      // construct here. The cloud provider is built only when there is a box.
      const sandbox =
        localPrepared !== null
          ? localPrepared.sandbox
          : createE2BHarnessSandboxProvider({
        sandboxId: sandboxId!,
        defaultWorkingDirectory,
        // The materialized secrets, as a session-wide env bag on every `run`
        // and `spawn`. This is the whole of materialized delivery on the
        // harness path: the agent runs `stripe customers list`, and
        // `STRIPE_API_KEY` is simply in that process's environment.
        //
        // In `envs`, never in the command line — the rule `plugin-box.ts`
        // already states: argv is readable by every process in the box through
        // `/proc`, and it lands in shell history.
        ...(sessionSecretEnv && Object.keys(sessionSecretEnv).length > 0
          ? {
              sessionEnv: sessionSecretEnv,
              // Stamped when the env is MERGED INTO A COMMAND, not here.
              //
              // Constructing this provider only puts the values in a local
              // object — nothing has reached E2B yet, and harness setup can
              // still throw before any command runs (`startHarnessModelBroker`
              // below is the usual one). Stamping at construction made
              // `lastDeliveredAt` mean "a turn got this far", when the question
              // it is read for, before deleting a credential believed dormant,
              // is "did anything actually receive it".
              ...(onSecretEnvDelivered
                ? { onSessionEnvUsed: onSecretEnvDelivered }
                : {}),
            }
          : {}),
      });

      // 3b. BROKER delivery (the only credential path): the sandbox id is now
      // known, so have Convex mint the lease, keep the sandbox on its own
      // egress baseline, and install the lease into E2B's egress transform on
      // the model-proxy host — the inspector never sees the lease. Run the CLI
      // with dummy creds pointed at the returned proxy. Fail-fast on install
      // error (the box is awake but no real credential exists anywhere).
      // RECORD the run id before the POST: if the backend installs the E2B rule
      // but the response is lost or aborted, teardown can still revoke by this
      // id (the backend keys revoke on runId). From here on a lease may exist.
      let auth: HarnessAuth;
      if (localPrepared !== null) {
        // LOCAL: the lease was obtained in `prepareLocalHarnessTurn`, before
        // anything was spawned, and it is held by the loopback gateway rather
        // than by the child. What the child gets here is that gateway's URL and
        // a per-session capability that means nothing anywhere else.
        auth = localPrepared.auth;
      } else if (externalAccountAuth) {
        // EXTERNAL-ACCOUNT: no lease exists to mint, so this whole step is
        // skipped rather than made conditional inside it. `brokerRunId` stays
        // unset, which is what keeps teardown from issuing a revoke for a lease
        // that never existed.
        //
        // The RESERVATION is deliberately NOT released here. On the brokered
        // path the lease consumes the claim and takes over the per-box fence;
        // with no lease there is nothing to take over, so the claim has to be
        // held by heartbeat for the whole turn — otherwise a second Cursor turn
        // could start bootstrapping the same box mid-run. `reservationHeld`
        // stays true and the turn's own teardown releases it.
        auth = externalAccountAuth;
      } else {
        brokerRunId = turnRunId;
        const broker = await startHarnessModelBroker({
          // The project and the execution scope are fields of `box`'s COMPUTER
          // arm (set where `box` is built, above), so the ephemeral path has no
          // way to send either: the backend derives project + billing org from
          // the sandbox row's run.
          box: box!,
          harnessId: harnessAdapter.id,
          modelId,
          runId: brokerRunId,
          bearer: authHeader,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (!broker.ok) {
          // Throws propagate to the turn's outer catch; onFinishEngine frees the
          // claimed lane (sessionEstablished still false) and revokes the broker
          // lease (brokerRunId set) if the backend installed before a lost response.
          throw new Error(broker.error);
        }
        // The lease is recorded, which consumed this turn's claim on the box; the
        // lease's own per-box fence covers the rest of the turn. Releasing now
        // would free a box that is very much still in use.
        clearReservationHeartbeat();
        reservationHeld = false;
        auth = buildBrokerDummyAuth(harnessAdapter.id, broker.proxyBaseUrl);
      }
      tBroker = Date.now();

      // 4. Assemble the harness over the host's E2B computer (the provider and
      // its working directory were resolved in step 3a, so the streaming session
      // uses the same one).
      // (permissionMode was computed above, before the runtime fingerprint.)

      // The adapter maps the host modelId to the harness's native model and
      // constructs it (for Claude Code: the gateway `creator/model` id becomes a
      // CLI-native alias `sonnet|opus|haiku`; the raw gateway id makes the CLI
      // do zero inference). Returns the HarnessAgent boundary type directly.
      //
      // Narrowed on the delivery MECHANISM rather than called through the
      // union: a `session-config` adapter's `createHarness` REQUIRES `mcpJson`
      // (its only channel for MCP config), and a `sandbox-files` one does not
      // take it at all. Writing the branch here is what makes "the servers
      // cannot be silently dropped at construction" a compile-time fact instead
      // of a convention.
      const harnessRuntime =
        harnessAdapter.mcpDelivery === "native" &&
        harnessAdapter.mcpNativeDelivery === "session-config"
          ? harnessAdapter.createHarness({ modelId, auth, mcpJson })
          : harnessAdapter.createHarness({ modelId, auth });
      // MCPJam's server-executed tools. The harness forwards each as a tool spec
      // to the runtime; when the runtime calls one it pauses, the agent runs the
      // tool's `execute()` HERE on MCPJam's server, and submits the result back.
      // Cast across the dual-`ai` boundary, same as the harness adapter above
      // (structurally identical ToolSet types).
      //
      // Two sources, and never both for the same MCP tool:
      //   - the host's built-ins (e.g. web_search), always;
      //   - on HOST-EXECUTED delivery only, the selected servers' MCP tools.
      //     Under NATIVE delivery `hostExecutedMcp.tools` is empty by
      //     construction (the branch above never ran), because those tools reach
      //     the runtime via `.mcp.json` and its own MCP client — so the model
      //     never sees a tool twice.
      // Built-ins are spread LAST: their names are unprefixed, MCP projections
      // are `mcp__…`-prefixed, so the two sets cannot collide — but if a future
      // built-in ever took an `mcp__` name, the host's own built-in wins rather
      // than being shadowed by a server.
      const hostExecutedTools = {
        ...hostExecutedMcp.tools,
        ...((builtInTools ?? {}) as Record<string, unknown>),
      } as Record<string, unknown>;
      const agent = new HarnessAgent({
        harness: harnessRuntime,
        sandbox,
        // Deliver skills via the adapter's own param (host-agnostic: it writes
        // them natively at the real $HOME — Claude Code under `.claude/skills`,
        // Codex under `.agents/skills`). The per-adapter `prepareSkills` owns the
        // payload shaping (both runtimes interpolate `description` into YAML
        // frontmatter RAW, so it is pre-encoded).
        ...(preparedSkills && preparedSkills.payload.length
          ? {
              skills: preparedSkills.payload as NonNullable<
                ConstructorParameters<typeof HarnessAgent>[0]["skills"]
              >,
            }
          : {}),
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
        ...(Object.keys(hostExecutedTools).length
          ? {
              tools: hostExecutedTools as NonNullable<
                ConstructorParameters<typeof HarnessAgent>[0]["tools"]
              >,
            }
          : {}),
        permissionMode,
        // WS3: gate host-executed tools (web_search, …) behind approval too —
        // permissionMode only covers the harness's native built-ins. Honors the
        // adapter's declared capability (advertise = enforce).
        ...(requireToolApproval &&
        harnessAdapter.supportsHostExecutedToolApproval &&
        Object.keys(hostExecutedTools).length
          ? {
              toolApproval: Object.fromEntries(
                Object.keys(hostExecutedTools).map((n) => [n, "user-approval"]),
              ) as NonNullable<
                ConstructorParameters<typeof HarnessAgent>[0]["toolApproval"]
              >,
            }
          : {}),
        onSandboxSession: async ({ session, sessionWorkDir }) => {
          // Capture the file-capable sandbox session for the turn-end adoption
          // pass (the finally's agent session has no file I/O). Stays valid until
          // the box is detached/destroyed, which happens AFTER adoption.
          sandboxFileSession = session;
          // NATIVE delivery only: write the host's MCP servers into the session
          // before the runtime starts, via the adapter's own strategy (Claude
          // Code writes a `.mcp.json`). A host-executed adapter has nothing to
          // write — its servers already went out as `tools` above — and the
          // adapter union forbids it from carrying `deliverMcpServers` at all.
          if (
            harnessAdapter.mcpDelivery === "native" &&
            harnessAdapter.mcpNativeDelivery === "sandbox-files"
          ) {
            // The "advertises MCP but has no delivery strategy" throw that used
            // to guard this call is GONE, not relaxed: each native MECHANISM of
            // `HarnessRuntimeAdapter` REQUIRES its own hook, so the
            // misconfiguration it caught is a compile error instead of a
            // turn-time one (tsc reports the old check's body as `never`).
            //
            // The other native mechanism (`session-config`) has nothing to do
            // here by construction: its servers were passed to `createHarness`
            // above, before this session existed.
            await harnessAdapter.deliverMcpServers({
              // Bind to the live session here (it lives behind the dual-`ai`
              // boundary) so the adapter stays free of the harness session type.
              writeTextFile: async (a) => {
                await session.writeTextFile(a);
              },
              sessionWorkDir,
              mcpJson,
            });
          }
          // VERSION CANARY. For an adapter whose CLI version is not pinned by
          // the package pin (Cursor bootstraps `curl … | bash`, which always
          // fetches the current build), ask the box what it actually installed
          // and record it. Two known cursor-agent builds are four months of
          // behaviour apart, so without this a silent upstream change presents
          // as an unattributable regression.
          //
          // FAIL-SOFT in every direction: bounded by the turn's own signal plus
          // a deadline, every error swallowed, and nothing downstream reads the
          // result. A canary must never be able to fail a run.
          if (harnessAdapter.runtimeVersionCommand) {
            try {
              const probe = await session.run({
                command: harnessAdapter.runtimeVersionCommand(sessionWorkDir),
                abortSignal: abortSignal
                  ? AbortSignal.any([
                      abortSignal,
                      AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
                    ])
                  : AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
              });
              const version = probe.stdout.trim().split("\n")[0]?.trim();
              if (probe.exitCode === 0 && version) {
                installedRuntimeVersion = version;
              }
            } catch {
              // Deliberately silent: see above.
            }
          }
          // The adapter writes skill CONTENT (via the `skills` param above); this
          // pass only removes managed dirs deleted/renamed in Convex (the adapter
          // has no deletion semantics and the box persists). Skipped on a fetch
          // failure (`runtimeSkills === null`) so a transient blip never deletes,
          // and only for skills-capable adapters.
          if (harnessAdapter.supportsSkills && runtimeSkills !== null) {
            await reconcileSkillDirs({
              session,
              skills: deliveredSkills,
              skillsHash: skillsHash ?? "",
              skillsBase: harnessAdapter.skillsBaseDir,
              ...(abortSignal ? { signal: abortSignal } : {}),
            }).catch(() => {});
            // OWNERSHIP PRE-SEED (stable adapter line). The adapter re-writes
            // its skills at the start of EVERY prompt turn via `writeSkills`,
            // which refuses any pre-existing dir absent from its own
            // `.ai-sdk-harness-skills.json` — and the materialize passes below
            // create exactly those dirs. Running the SAME write here first
            // (same payload, same options ⇒ same content hash) makes the
            // adapter's turn-time call a hash-unchanged no-op: dirs become
            // adapter-owned BEFORE supporting files/frontmatter land in them,
            // and stay untouched after. Legacy dirs MCPJam managed before the
            // adapter manifest existed are handed off (removed) first; the
            // pre-seed re-writes them in the same breath. A genuinely foreign
            // colliding dir still throws the adapter's own "not owned" error —
            // just here, before any MCPJam pass has touched the box.
            if (preparedSkills && preparedSkills.payload.length > 0) {
              await handOffLegacySkillDirs({
                session,
                skillsBase: harnessAdapter.skillsBaseDir,
                deliveredNames: deliveredSkills.map((s) => s.name),
                ...(abortSignal ? { signal: abortSignal } : {}),
              });
              await preseedAdapterSkills({
                session,
                skillsBase: harnessAdapter.skillsBaseDir,
                payload: preparedSkills.payload,
                trailingNewline:
                  harnessAdapter.skillsWriteOptions.trailingNewline,
                ...(abortSignal ? { signal: abortSignal } : {}),
              });
            }
            // PINNED MODE: supporting files ride INLINE on the pinned
            // artifacts (P0.2 host-channel plugin skills) — never the live
            // file query. Env-channel entries are SKILL.md-only under P0.3.
            // Always invoked (not gated on `some(files)`): the writer also
            // PRUNES stale files so a reused box matches the pinned snapshot
            // exactly — a skill whose file set became empty must still have its
            // prior-run orphans removed.
            if (skillsArePinned) {
              await materializePinnedSkillFiles({
                session,
                artifacts: pinnedHarnessSkills!,
                skillsBase: harnessAdapter.skillsBaseDir,
                ...(abortSignal ? { signal: abortSignal } : {}),
              }).catch(() => {});
            }
            // Materialize supporting files AFTER the pre-seed (each SKILL.md is
            // written and adapter-owned; reconcile removed stale managed dirs),
            // so the files land in dirs the adapter's turn-time write will not
            // refuse or clobber. Fetched here rather
            // than at turn start to keep the zero-file fast path free. Fully
            // fail-soft; guest/swarm scope uses the execution-scoped file query.
            //
            // ENVIRONMENT MODE (INS-7): files come from the SAME resolution
            // that produced the skills, not from a second query.
            //
            // This is not just an efficiency: the project-wide file query
            // (`projectSkills:listSkillFilesForRuntime`) filters rows through
            // `isStandaloneSkill`, which excludes `plugin_component` rows by
            // construction — so a plugin skill delivered to a Computer reached
            // the box as a bare SKILL.md, with its `scripts/` and `references/`
            // silently absent. The resolved spec carries those files with signed
            // URLs minted in the same atomic read, so delivery consumes them.
            //
            // Presence of the capability set is authoritative (an empty file
            // list is a real "no supporting files" and still runs, so orphans
            // from a previous turn get pruned) — the tri-state fetch-failure
            // concern below does not apply, because there is no second fetch to
            // fail.
            else if (
              effectiveCapabilities !== undefined &&
              deliveredSkills.length > 0
            ) {
              await materializeSkillFiles({
                session,
                files: capabilitySkillFiles(effectiveCapabilities),
                skillNamesById: deliveredSkillNamesById,
                skillsBase: harnessAdapter.skillsBaseDir,
                ...(uploadQuotaComputerId
                  ? { computerId: uploadQuotaComputerId }
                  : {}),
                ...(abortSignal ? { signal: abortSignal } : {}),
              }).catch(() => {});
              const pluginSkills = pluginSkillDeliverySummary(
                effectiveCapabilities,
              );
              if (pluginSkills.length > 0) {
                // Provenance, not a pin: which plugin material this sandbox was
                // given. Never re-read to restore anything.
                logger.info("[harness] delivered plugin skills", {
                  // The BOX this material went to — a computer row id or an
                  // ephemeral sandbox row id. Provenance, not a pin.
                  boxKind: box?.kind ?? "local-native",
                  boxId: computerId,
                  skills: pluginSkills,
                });
              }
              // INS-8 ORIGIN MAPPING: the same delivery, keyed by the identity
              // the RUNTIME exposes (the on-box dir it reads the skill from), so
              // a skill operation observed on the box is attributable to the
              // exact immutable plugin revision that produced it — per runtime,
              // since the root differs (Codex `.agents/skills`).
              const skillOrigins = deliveredPluginSkillOrigins({
                set: effectiveCapabilities,
                skillsBaseDir: harnessAdapter.skillsBaseDir,
                deliveredNameBySkillId: deliveredSkillNamesById,
              });
              if (skillOrigins.length > 0) {
                logger.info("[harness] plugin skill origins", {
                  harness: harnessAdapter.id,
                  origins: skillOrigins,
                });
              }
            }
            // LEGACY / non-environment mode. The file query stays PROJECT-WIDE
            // while the delivered skill set may be narrower:
            // `materializeSkillFiles` filters every file through
            // `skillNamesById`, which is built from `runtimeSkills` alone, so a
            // file belonging to a project skill this turn did NOT deliver is
            // skipped and its dir is never created.
            else if (projectId && authHeader && deliveredSkills.length > 0) {
              // Tri-state: `{ ok: false }` ⇒ the fetch FAILED (transient). Skip
              // materialization then — an empty file set would otherwise prune
              // every delivered skill's on-box files. `{ ok: true, files: [] }`
              // is a successful "no files" and still runs, so a skill whose last
              // file was removed gets pruned.
              const fileResult = await fetchRuntimeSkillFiles(
                authHeader,
                projectId,
                executionScope,
              ).catch(() => ({ ok: false } as const));
              if (fileResult.ok) {
                await materializeSkillFiles({
                  session,
                  files: fileResult.files,
                  skillNamesById: deliveredSkillNamesById,
                  skillsBase: harnessAdapter.skillsBaseDir,
                  ...(uploadQuotaComputerId
                    ? { computerId: uploadQuotaComputerId }
                    : {}),
                  ...(abortSignal ? { signal: abortSignal } : {}),
                }).catch(() => {});
              }
            }
          }
          // Stream the workdir to the client (transient) so the Playground Shell
          // can open a terminal here instead of the box's home. The client keys
          // the cached path by project + host (it knows both); we only need the
          // path. Fires every turn (fresh or resumed) — always the current dir.
          writer.write({
            type: "data-harness-session",
            data: { workdir: sessionWorkDir },
            transient: true,
          } as unknown as UIMessageChunk);
        },
      });

      // maxSteps (MCPJamHandlerOptions) is intentionally NOT enforced here. It
      // caps MCPJam's *emulated* agentic loop; the harness exposes no equivalent
      // knob and the real Claude Code owns its own loop, so its "steps" aren't
      // MCPJam steps — a client-side cap would cut the real agent off mid-task
      // and defeat the point of observing it (same rationale as progressive tool
      // discovery above). The turn-level abortSignal/timeout (propagated into
      // agent.stream below) is the cost/runaway backstop.
      //
      // Resume-or-fresh: if the claimed lane has resume state captured on THIS
      // computer (the workdir lives there), reattach the Claude Code thread so
      // prior turns carry over. getHarnessResumeEligibility decides whether the
      // sidecar can warm-resume on this computer AND sandbox — a reprovisioned
      // box (sandbox-replaced) can't, so we go fresh and SURFACE a visible reset
      // (below) instead of the adapter silently spawning a blank session. A
      // legacy pre-detach sidecar is cold-resumed (logged, not surfaced).
      const eligibility = getHarnessResumeEligibility({
        state: continuity?.state ?? null,
        computerId,
        // Null on the local path: there is no vendor sandbox id, and the
        // continuity identity is the `<machineId>:<runtimeId>` in `computerId`
        // above. Passing a placeholder would make a resumed local session look
        // attachable to a box.
        sandboxId: sandboxId ?? "",
      });
      const resumable = eligibility.resume
        ? continuity?.state ?? undefined
        : undefined;
      // Categorical reason to surface to the client (never a raw sandbox id).
      // Only hard resets are shown; legacy-cold-resume is a logged attempt.
      let resetReason: HarnessResetReason | undefined =
        eligibility.reason === "sandbox-replaced"
          ? "sandbox-replaced"
          : undefined;
      if (eligibility.reason === "legacy-cold-resume") {
        logger.warn(
          "[harness] resuming a pre-detach sidecar (cold/disk resume; continuity not guaranteed)",
          { harnessSessionId: continuity?.state?.harnessSessionId },
        );
      }
      // WS3: resuming a turn the user just approved/denied. The committed state
      // is a `continue-turn` payload (awaitingApproval), reattached via
      // continueFrom (NOT resumeFrom) and continued with continueStream below.
      const resumeFromApproval =
        isApprovalResume && resumable?.awaitingApproval === true;
      let session: Awaited<ReturnType<typeof agent.createSession>>;
      if (resumeFromApproval && resumable) {
        // No fresh fallback here: if the paused continuation is stale (computer
        // moved / schema drift) the decision can't be applied — fail closed via
        // the throw so the user retries rather than silently losing the call.
        session = await agent.createSession({
          sessionId: resumable.harnessSessionId,
          continueFrom: resumable.resumeState,
        } as unknown as Parameters<typeof agent.createSession>[0]);
        resumedSession = true;
      } else if (resumable) {
        try {
          session = await agent.createSession({
            sessionId: resumable.harnessSessionId,
            resumeFrom: resumable.resumeState,
          } as unknown as Parameters<typeof agent.createSession>[0]);
          resumedSession = true;
        } catch (resumeErr) {
          logger.warn("[harness] resume failed; starting fresh", {
            error: resumeErr instanceof Error ? resumeErr.message : resumeErr,
          });
          // Reattach threw — fall back fresh, but make it VISIBLE (the adapter
          // swallows its own reattach failures; this catch is our last signal).
          resetReason = "resume-failed";
          session = await agent.createSession();
        }
      } else {
        session = await agent.createSession();
      }
      // Surface a visible reset (transient, never persisted) so a lost session
      // reads as an explained "new session" rather than the model forgetting.
      // Carries only the categorical reason — NEVER a raw E2B sandbox id.
      if (resetReason) {
        writer.write({
          type: "data-harness-reset",
          data: { reason: resetReason },
          transient: true,
        } as unknown as UIMessageChunk);
      }
      tConnect = Date.now();
      // Session is up: the finalizer + heartbeat now own the continuity lane, so
      // the pre-session cleanup in onFinishEngine no longer needs to free it.
      sessionEstablished = true;

      // DELIVERY STAMP for the external-account credential — HERE, because this
      // is the first point at which the runtime has actually taken it: the
      // adapter starts the CLI and completes its handshake inside
      // `createSession`, so a session that resolved is a process that accepted
      // the credential. Earlier points looked plausible and were not: resolving
      // `auth` only puts the value in a local object, and `onSandboxSession`
      // fires before the process exists at all — both would report a delivery
      // that setup could still have thrown before making.
      //
      // It has to be stamped explicitly at all because this path took the
      // credential OUT of the box's session env bag, so the provider's own
      // `onSessionEnvUsed` can never fire for it: for a project whose only
      // secret is this one the bag is empty and nothing would ever stamp,
      // making a live credential read as dormant to whoever is deciding whether
      // it is safe to delete.
      // BROKERED names are excluded on purpose: the backend delivered them
      // into the box's egress transform, this process never held the value,
      // and `markSecretsDelivered` re-resolves the MATERIALIZED grant — so
      // stamping here would credit a delivery neither side made.
      if (
        externalAccountPlan &&
        externalAccountPlan.materializedNames.length > 0
      ) {
        onSecretEnvDelivered?.();
      }

      // Re-write SKILL.md WITH preserved extra frontmatter (allowed-tools /
      // license / …) for skills that carry it. The adapter's `skills` param
      // structurally can't deliver those fields. The `onSandboxSession`
      // pre-seed wrote each (extras-less) SKILL.md and made the adapter's own
      // per-prompt write a hash-unchanged no-op, so this rewrite survives the
      // turn; it runs post-createSession only to keep it off the session-start
      // critical path.
      // Fail-soft (never fails the turn); zero session calls when no skill
      // has extras; same gating as the onSandboxSession skill passes.
      if (deliveredSkills.length > 0 && sandboxFileSession) {
        await materializeSkillFrontmatter({
          session: sandboxFileSession,
          skills: deliveredSkills,
          skillsBase: harnessAdapter.skillsBaseDir,
          ...(abortSignal ? { signal: abortSignal } : {}),
        }).catch(() => {});
      }

      // Heartbeat the lease while we stream (turns can outlive the TTL). The
      // heartbeat is the liveness guard: it aborts the turn on a DEFINITIVE
      // lease loss, tolerates transient failures (network blips), and gives up
      // only if those transients span the whole lease TTL ("lost liveness").
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      if (continuity) {
        const c = continuity;
        let firstRetryableAt = 0;
        heartbeatTimer = setInterval(() => {
          void heartbeatHarnessSessionState({
            owner: c.owner,
            leaseId: c.leaseId,
            leaseTtlMs: HARNESS_LEASE_TTL_MS,
            bearer: authHeader,
          }).then((result) => {
            if (result === "ok") {
              firstRetryableAt = 0;
              return;
            }
            if (result === "lost") {
              logger.warn("[harness] lease lost — aborting turn", {
                leaseId: c.leaseId,
              });
              livenessAbort.abort(new Error("harness lease lost"));
              return;
            }
            // retryable: tolerate blips, but don't run blind forever
            if (firstRetryableAt === 0) firstRetryableAt = Date.now();
            const elapsedMs = Date.now() - firstRetryableAt;
            logger.warn("[harness] heartbeat transient failure; will retry", {
              elapsedMs,
            });
            if (elapsedMs >= HARNESS_LEASE_TTL_MS) {
              logger.warn(
                "[harness] heartbeat lost liveness past TTL — aborting turn",
              );
              livenessAbort.abort(new Error("harness lost liveness"));
            }
          });
        }, HARNESS_HEARTBEAT_MS);
      }
      try {
        // v6 messages → v7 agent input: a documented loose cast at the boundary.
        // `session` is REQUIRED — agent.stream() reads options.session in
        // _startTurn (session.promptTurn); omitting it throws "Cannot read
        // properties of undefined (reading 'promptTurn')". `_resolveTurnInput`
        // accepts `messages` and uses the last role:"user" entry as the prompt.
        // WS3: a resume carries no new user prompt — feed the approval decision
        // into the in-flight turn via continueStream (the adapter collapses
        // `messages` to the last user message, so stream() would re-prompt).
        // Everything above this line is ours; everything at or below it is the
        // model's turn. See `modelInvoked`.
        modelInvoked = true;
        const res = resumeFromApproval
          ? await agent.continueStream({
              session,
              toolApprovalContinuations: approvalContinuations,
              abortSignal: effectiveAbortSignal,
            } as unknown as Parameters<typeof agent.continueStream>[0])
          : await agent.stream({
              session,
              messages,
              // Hand the harness the combined abort signal so a user cancel OR a
              // lost-lease liveness abort propagates into the in-sandbox run.
              abortSignal: effectiveAbortSignal,
            } as unknown as Parameters<typeof agent.stream>[0]);

        // Read the harness fullStream LOOSELY and hand-build ai@6 UI chunks.
        // Reconstruct the transcript INCREMENTALLY so persisted history keeps
        // the required assistant → tool → assistant ordering across steps:
        // assistantParts holds the in-progress assistant message (text
        // interleaved with tool-calls in stream order); pendingResults holds the
        // current step's tool results. New assistant content after results means
        // the next step has begun, so the prior segment is flushed first.
        const assistantParts: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: unknown;
              providerOptions?: Record<string, unknown>;
            }
        > = [];
        const pendingResults: Array<{
          toolCallId: string;
          toolName: string | undefined;
          output: unknown;
          isError: boolean;
          serverId?: string;
        }> = [];
        const projectAssistantText = (text: string) => {
          const finalTextId = crypto.randomUUID();
          emitTextStart(writer, finalTextId);
          emitTextDelta(writer, finalTextId, text);
          emitTextEnd(writer, finalTextId);
          emittedAnyText = true;
          // Whitespace-only text renders as a blank message to the user, so it
          // must not count toward the "produced visible output" completeness
          // check below (else a whitespace-only harness answer would silently
          // skip the HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT fallback).
          if (text.trim().length > 0) {
            emittedAnyVisiblePart = true;
          }
          onLiveTextDelta?.(text);
          const lastPart = assistantParts[assistantParts.length - 1];
          if (lastPart && lastPart.type === "text") {
            lastPart.text += text;
          } else {
            assistantParts.push({ type: "text", text });
          }
        };
        const flushSegment = () => {
          if (assistantParts.length > 0) {
            const assistantMsgIndex = messageHistory.length;
            messageHistory.push({
              role: "assistant",
              content: [...assistantParts],
            } as unknown as ModelMessage);
            assistantParts.length = 0;
            // Synthetic agent span: renders the "Agent:" row (llm category) and
            // guarantees non-empty trace spans even when the step produced only
            // text. The harness can't observe genuine LLM latency/tokens, so the
            // span is a wall-clock envelope; cumulative usage is attached once
            // the final flush runs after `await res.text` settles it.
            capturedSpans.push({
              id: crypto.randomUUID(),
              name: modelId,
              category: "llm",
              // Span times are turn-relative offsets (ms from traceBaseMs), not
              // absolute epoch — the timeline treats endMs as an offset
              // (getTraceSpansDurationMs = max(endMs)) and rebases turns end-to-end.
              ...createOffsetInterval(traceBaseMs, stepStartedAt, Date.now()),
              promptIndex,
              stepIndex,
              status: "ok",
              messageStartIndex: assistantMsgIndex,
              messageEndIndex: assistantMsgIndex,
              modelId,
              finishReason: turnFinishReason,
              ...(usage
                ? {
                    ...(typeof usage.inputTokens === "number"
                      ? { inputTokens: usage.inputTokens }
                      : {}),
                    ...(typeof usage.outputTokens === "number"
                      ? { outputTokens: usage.outputTokens }
                      : {}),
                    ...(typeof usage.totalTokens === "number"
                      ? { totalTokens: usage.totalTokens }
                      : {}),
                  }
                : {}),
            });
          }
          const flushedToolCallIds = new Set(
            pendingResults.map((tr) => tr.toolCallId),
          );
          for (const tr of pendingResults) {
            messageHistory.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: tr.toolCallId,
                  toolName: tr.toolName ?? "tool",
                  // Single-wrap, matching the emulated engine: errors → error-text;
                  // already-typed outputs pass through (no double-nest); else json.
                  output: toToolResultOutput(tr.output, tr.isError),
                  ...(tr.serverId
                    ? {
                        providerOptions: mergeMcpToolOriginMetadata(
                          undefined,
                          tr.serverId,
                        ),
                      }
                    : {}),
                },
              ],
            } as unknown as ModelMessage);
          }
          pendingResults.length = 0;
          // Back-fill messageStartIndex/EndIndex on this step's tool spans now
          // that their tool-result messages exist in messageHistory (trace ↔
          // transcript correlation; parity with runChatEngineLoop).
          setToolSpanMessageRangesFromResults(
            capturedSpans,
            messageHistory,
            promptIndex,
            stepIndex,
            flushedToolCallIds,
          );
        };
        // Step + tool-identity tracking. A "step" spans assistant content + its
        // tool results; the next assistant content after results begins the next
        // step. finishStep emits the emulated engine's onStepFinish contract
        // (eval's stream runner turns it into a `step_finish` SSE snapshot).
        let stepIndex = 0;
        const toolMeta = new Map<
          string,
          { serverId?: string; toolName: string }
        >();
        const toolStartMs = new Map<string, number>();
        const finishStep = () => {
          // Usage is only known at the harness `finish`, so intermediate steps
          // carry what's settled (driver reads its cumulative `usage`).
          activeDriver.fireStepFinish(stepIndex, false);
          // Stream the cumulative spans + messages to the live Trace tab. This
          // is the event that flips the tab off its "Sample trace" placeholder.
          emitTraceSnapshot(
            writer,
            messageHistory,
            toolSetForTrace as unknown as ToolSet,
            activeDriver.snapshotContext(messageHistory),
          );
          stepIndex += 1;
          stepStartedAt = Date.now();
        };
        // Emit turn_start here (not at function entry) so a pre-stream failure
        // (credential/box/connect) never creates a phantom turn in the trace.
        // Anchor the trace clock to stream start so setup latency isn't a gap.
        traceBaseMs = Date.now();
        const activeDriver = new StreamTurnDriver({
          turnId,
          promptIndex,
          modelId,
          engine: "harness",
          harness,
          traceBaseMs,
          spans: capturedSpans,
          onStepFinish,
        });
        driver = activeDriver;
        activeDriver.emitTurnStart(writer);
        stepStartedAt = traceBaseMs;
        harnessStream: for await (const part of res.fullStream as AsyncIterable<
          Record<string, unknown> & { type?: string }
        >) {
          if (effectiveAbortSignal.aborted) {
            aborted = true;
            break;
          }
          if (scopeStepUpCreation && suspendedHarnessToolCallId) {
            await scopeStepUpCreation;
            if (pausedForScopeStepUp) break;
          }
          const type = part.type;
          if (typeof type === "string") seenHarnessPartTypes.add(type);
          if (
            type === "reasoning-start" ||
            type === "reasoning-delta" ||
            type === "reasoning-end"
          ) {
            // Surface the harness's reasoning as a live UI reasoning part (the
            // emulated engine forwards the identical chunks from Convex).
            if (type === "reasoning-end") {
              closeReasoning();
            } else {
              if (reasoningId === undefined) {
                reasoningId = String(
                  (part as { id?: unknown }).id ?? crypto.randomUUID(),
                );
                emitReasoningStart(writer, reasoningId);
              }
              if (type === "reasoning-delta") {
                const rDelta = String(
                  (part as { text?: unknown; delta?: unknown }).text ??
                    (part as { delta?: unknown }).delta ??
                    "",
                );
                if (rDelta) emitReasoningDelta(writer, reasoningId, rDelta);
              }
            }
          } else if (type === "text-delta" || type === "text") {
            closeReasoning();
            const delta = String(
              (part as { text?: unknown; delta?: unknown }).delta ??
                (part as { text?: unknown }).text ??
                "",
            );
            if (!delta) continue;
            // Assistant text after tool results begins the next step.
            if (pendingResults.length > 0) {
              flushSegment();
              finishStep();
            }
            if (textId === undefined) {
              textId = crypto.randomUUID();
              emitTextStart(writer, textId);
            }
            // Append to the open trailing text part, or start a new one, so
            // text keeps its order relative to tool-calls.
            const lastPart = assistantParts[assistantParts.length - 1];
            if (lastPart && lastPart.type === "text") {
              lastPart.text += delta;
            } else {
              assistantParts.push({ type: "text", text: delta });
            }
            emitTextDelta(writer, textId, delta);
            emittedAnyText = true;
            // See the whitespace-only note on projectAssistantText above.
            if (delta.trim().length > 0) {
              emittedAnyVisiblePart = true;
            }
            onLiveTextDelta?.(delta);
          } else if (type === "tool-call" || type === "tool-input-available") {
            closeReasoning();
            // A tool-call after tool results begins the next step.
            if (pendingResults.length > 0) {
              flushSegment();
              finishStep();
            }
            // Flush any open text block before the tool so the UI stream stays
            // balanced (matches the emulated engine's flush-before-tool order);
            // later text opens a fresh block with a new id.
            if (textId !== undefined) {
              emitTextEnd(writer, textId);
              textId = undefined;
            }
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ??
                crypto.randomUUID(),
            );
            const rawToolName = String(
              (part as { toolName?: unknown }).toolName ?? "tool",
            );
            const input = coerceToolInput(
              (part as { input?: unknown }).input ??
                (part as { args?: unknown }).args ??
                {},
            );
            // Map back to { serverId, un-namespaced toolName } so the UI chunks,
            // engine callbacks, and persisted transcript carry MCPJam tool
            // identity (eval matching + MCP App rendering key off it).
            //
            // Name AND input, because not every runtime puts the identity in the
            // name: Claude Code namespaces MCP tools as `mcp__<server>__<tool>`
            // (native tools have no prefix → serverId stays undefined), while
            // Cursor streams every MCP call as an opaque `acp_tool_<id>` and
            // carries `{ providerIdentifier, toolName }` in the input instead.
            // The adapter decides; this call site only has to hand over both.
            // (Which is why `input` is now resolved FIRST — it is an argument to
            // the attribution, not just something recorded after it.)
            const { serverId, toolName } = harnessAdapter.attributeToolCall
              ? harnessAdapter.attributeToolCall({
                  rawToolName,
                  input,
                  keyToServerId: harnessKeyToServerId,
                })
              : harnessAdapter.parseToolName(rawToolName, harnessKeyToServerId);
            toolMeta.set(toolCallId, {
              ...(serverId ? { serverId } : {}),
              toolName,
            });
            // Stand-in ToolSet entry so emitTraceSnapshot's collectActualToolCalls
            // can resolve this tool's serverId (the harness has no `ai` ToolSet).
            toolSetForTrace[toolName] = serverId ? { _serverId: serverId } : {};
            toolStartMs.set(toolCallId, Date.now());
            // providerExecuted:true — the harness runs ALL tools in-sandbox
            // (Claude Code executes them itself). Without it the client treats
            // these as client-side tools to fulfill and `sendAutomaticallyWhen`
            // auto-continues, re-submitting the turn forever.
            const providerMetadata = mergeMcpToolOriginMetadata(
              undefined,
              serverId,
            );
            writer.write({
              type: "tool-input-available",
              toolCallId,
              toolName,
              input,
              providerExecuted: true,
              ...(providerMetadata ? { providerMetadata } : {}),
            });
            emittedAnyVisiblePart = true;
            await onToolCall?.({
              toolCallId,
              toolName,
              input,
              stepIndex,
              promptIndex,
              serverId,
            });
            assistantParts.push({
              type: "tool-call",
              toolCallId,
              toolName,
              input,
              ...(providerMetadata
                ? { providerOptions: providerMetadata }
                : {}),
            });
            observedHarnessToolCalls.push({
              toolCallId,
              ...(serverId ? { serverId } : {}),
              toolName,
              input,
            });
            tryCreateHarnessScopeStepUp();
          } else if (
            type === "tool-result" ||
            type === "tool-output-available"
          ) {
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ?? "",
            );
            // HOST-EXECUTED delivery: prefer the raw result captured at
            // `execute()` time over the runtime's echo, which is the model-facing
            // projection we handed it. `has` rather than a truthiness check —
            // a tool may legitimately resolve `undefined`.
            const hasRawHostExecuted = hostExecutedRawResults.has(toolCallId);
            const rawHostExecuted = hostExecutedRawResults.get(toolCallId);
            hostExecutedRawResults.delete(toolCallId);
            const output = hasRawHostExecuted
              ? rawHostExecuted
              : (part as { output?: unknown }).output ??
                (part as { result?: unknown }).result;
            // Surface tool failures the harness reports so eval/trace consumers
            // that key off isError classify them correctly.
            const isError =
              (part as { isError?: unknown }).isError === true ||
              (part as { error?: unknown }).error != null;
            // Reuse the identity resolved at tool-call time (the result part may
            // omit the name); fall back to parsing the result's own toolName.
            // Name-only on purpose: a RESULT part carries no call input, so
            // `attributeToolCall` would have nothing extra to work with. The
            // identity resolved at call time (above) is the real answer and this
            // is only its fallback.
            const meta =
              toolMeta.get(toolCallId) ??
              harnessAdapter.parseToolName(
                String((part as { toolName?: unknown }).toolName ?? "tool"),
                harnessKeyToServerId,
              );
            // A tool call the MCP proxy blocked on policy, recognised only when
            // THIS run sealed a policy for that server, and only ever with the
            // verdict that snapshot already holds — a server echoing the block
            // text cannot invent one for a tool the policy allows.
            //
            // Two sources, because neither alone is enough: the proxy's own
            // channel report is authoritative but may arrive after this result
            // (cross-replica), and the result itself is synchronous but reaches
            // us as whatever the harness made of it (Claude Code flattens it to
            // a bare string, dropping `_meta`). Either one blocks the call.
            const policySnapshot = meta.serverId
              ? harnessToolPolicy?.[meta.serverId]
              : undefined;
            const channelBlock = policySnapshot
              ? claimChannelPolicyBlock(meta.serverId ?? "", meta.toolName)
              : undefined;
            const resultBlock = policySnapshot
              ? readHarnessPolicyBlockFromResult({
                  output,
                  snapshot: policySnapshot,
                  toolName: meta.toolName,
                })
              : null;
            const policyBlock =
              resultBlock ??
              (channelBlock
                ? {
                    toolName: channelBlock.toolName,
                    reason: channelBlock.reason,
                    classification: channelBlock.classification,
                  }
                : null);
            if (policyBlock) {
              if (!channelBlock && meta.serverId) {
                noteAccountedPolicyBlock(meta.serverId, meta.toolName);
              }
              harnessPolicyBlocks.push({
                toolName: policyBlock.toolName,
                reason: policyBlock.reason,
                classification: policyBlock.classification,
                at: channelBlock?.at ?? Date.now(),
                toolCallId,
                ...(meta.serverId ? { serverId: meta.serverId } : {}),
              });
              // Reported as it happens, not at finish: the caller excludes
              // blocked `toolCallId`s from the matcher off the returned
              // transcript, which it reads as soon as the turn resolves.
              flushHarnessPolicyBlocks();
            }
            if (
              scopeStepUpCreation &&
              toolCallId === suspendedHarnessToolCallId
            ) {
              await scopeStepUpCreation;
            }
            if (
              pausedForScopeStepUp &&
              toolCallId === suspendedHarnessToolCallId
            ) {
              break harnessStream;
            }
            // Provider-executed (in-sandbox) — see tool-input-available above.
            emitToolOutput(writer, {
              toolCallId,
              output,
              providerExecuted: true,
            });
            // A policy block is neither a tool result nor a tool span: it never
            // reached the server, so counting it as either would attribute a
            // MCPJam refusal to the customer's tool (a `notMeasured` +
            // `blockedByPolicy` outcome, never `failed`). It stays in the
            // transcript below, because the model did see the refusal.
            if (!policyBlock) {
              await onToolResult?.({
                toolCallId,
                toolName: meta.toolName,
                output,
                isError,
                stepIndex,
                promptIndex,
                serverId: meta.serverId,
              });
              // Record a tool span for the turn trace (cumulative; snapshotted
              // into each onStepFinish and the final PersistedTurnTrace.spans).
              capturedSpans.push({
                id: crypto.randomUUID(),
                name: meta.toolName,
                category: "tool",
                // Turn-relative offsets (see the llm span above).
                ...createOffsetInterval(
                  traceBaseMs,
                  toolStartMs.get(toolCallId) ?? Date.now(),
                  Date.now(),
                ),
                promptIndex,
                stepIndex,
                status: isError ? "error" : "ok",
                toolCallId,
                toolName: meta.toolName,
                ...(meta.serverId ? { serverId: meta.serverId } : {}),
              });
            }
            // `!policyBlock` for the SAME reason the result and span above
            // exclude it: a policy block never reached the server, so no tool
            // ran. Counting it here would let a turn whose every call MCPJam
            // refused look like a turn that did work — and the entitlement-wall
            // check reads this counter to decide whether an "upgrade your plan"
            // answer is a real answer. A blocked call plus that text is exactly
            // the case where the wall must still be caught.
            if (!policyBlock && !isError) successfulToolCalls += 1;
            pendingResults.push({
              toolCallId,
              toolName: meta.toolName,
              output,
              isError,
              ...(meta.serverId ? { serverId: meta.serverId } : {}),
            });
          } else if (type === "file-change") {
            // Some runtimes (Codex) report file mutations as a `file-change`
            // stream part that does NOT originate from a model-callable tool.
            // Surface it as a synthetic NATIVE provider-executed tool (serverId
            // undefined, like Bash) so it flows through the same UI emit + trace
            // span + transcript path. No serverId ⇒ eval MCP-tool matching
            // ignores it automatically. Only adapters that declare a
            // `fileChangeToolName` emit these (Claude Code does not).
            const fcName = harnessAdapter.fileChangeToolName;
            if (fcName) {
              // Begins a new step after prior results; close any open text block.
              if (pendingResults.length > 0) {
                flushSegment();
                finishStep();
              }
              if (textId !== undefined) {
                emitTextEnd(writer, textId);
                textId = undefined;
              }
              const toolCallId = crypto.randomUUID();
              const input = coerceToolInput({
                event: (part as { event?: unknown }).event,
                path: (part as { path?: unknown }).path,
              });
              const startMs = Date.now();
              toolMeta.set(toolCallId, { toolName: fcName });
              toolSetForTrace[fcName] = {};
              emitToolInput(writer, {
                toolCallId,
                toolName: fcName,
                input,
                providerExecuted: true,
              });
              emittedAnyVisiblePart = true;
              await onToolCall?.({
                toolCallId,
                toolName: fcName,
                input,
                stepIndex,
                promptIndex,
                // Native file mutation — not an MCP-server tool.
                serverId: undefined,
              });
              assistantParts.push({
                type: "tool-call",
                toolCallId,
                toolName: fcName,
                input,
              });
              // The part is self-contained (no separate result frame) — emit a
              // matching result immediately so the pair stays balanced.
              emitToolOutput(writer, {
                toolCallId,
                output: input,
                providerExecuted: true,
              });
              await onToolResult?.({
                toolCallId,
                toolName: fcName,
                output: input,
                isError: false,
                stepIndex,
                promptIndex,
                serverId: undefined,
              });
              capturedSpans.push({
                id: crypto.randomUUID(),
                name: fcName,
                category: "tool",
                ...createOffsetInterval(traceBaseMs, startMs, Date.now()),
                promptIndex,
                stepIndex,
                status: "ok",
                toolCallId,
                toolName: fcName,
              });
              pendingResults.push({
                toolCallId,
                toolName: fcName,
                output: input,
                isError: false,
              });
            }
          } else if (type === "tool-approval-request") {
            // WS3: the turn paused awaiting a tool approval. Surface MCPJam's
            // approval chunk (the SAME one the emulated engine emits → zero
            // client changes), close open blocks, and break — the finally
            // suspends the turn and commits the continuation (awaitingApproval).
            // NOTE: how the pause surfaces (this stream part vs turnState/
            // stream-end for built-in permissionMode tools) needs live
            // confirmation; host-tool `toolApproval` reliably emits this part.
            // Fail closed without a continuity lane: the finally can only
            // suspend + commit the continuation when `continuity` exists, so
            // emitting the approval chunk here would show the user a prompt
            // for a turn that can never resume.
            if (!continuity) {
              throw new Error(
                "Tool approval requested on a turn without a resumable harness session; aborting instead of pausing unresumably.",
              );
            }
            const approvalId = String(
              (part as { approvalId?: unknown }).approvalId ??
                crypto.randomUUID(),
            );
            const toolCallId = String(
              (part as { toolCallId?: unknown }).toolCallId ?? "",
            );
            closeReasoning();
            if (textId !== undefined) {
              emitTextEnd(writer, textId);
              textId = undefined;
            }
            emitToolApprovalRequest(writer, { approvalId, toolCallId });
            pausedForApproval = true;
            break;
          } else if (type === "finish") {
            const fr = (part as { finishReason?: unknown }).finishReason;
            if (typeof fr === "string" && fr)
              turnFinishReason = fr as FinishReason;
            const u =
              (part as { totalUsage?: unknown; usage?: unknown }).totalUsage ??
              (part as { usage?: unknown }).usage;
            if (u && typeof u === "object") {
              const ur = u as Record<string, unknown>;
              usage = {
                ...(typeof ur.inputTokens === "number"
                  ? { inputTokens: ur.inputTokens }
                  : {}),
                ...(typeof ur.outputTokens === "number"
                  ? { outputTokens: ur.outputTokens }
                  : {}),
                ...(typeof ur.totalTokens === "number"
                  ? { totalTokens: ur.totalTokens }
                  : {}),
              };
            }
          }
        }
        // Close any open text block first so BOTH the cancelled and normal
        // paths leave a balanced UI stream.
        closeReasoning();
        if (textId !== undefined) emitTextEnd(writer, textId);

        // Cancelled mid-stream: do NOT drain res.text (it would block until the
        // full harness run finishes). The finally below destroys the harness
        // session, stopping the in-sandbox Claude Code run.
        if (aborted) return;

        // WS3: paused awaiting approval. Do NOT `await res.text` — the turn
        // hasn't finished (it's suspended), so awaiting it would hang. Close
        // open blocks, emit a finish (tool-calls = "ended awaiting tool
        // resolution"), and let the finally suspend + commit the continuation.
        // runSucceeded stays false so onFinishEngine skips transcript persist
        // (the partial turn isn't a completed conversation).
        if (pausedForApproval) {
          closeReasoning();
          flushSegment();
          finishStep();
          emitFinish(writer, {
            finishReason: "tool-calls" as FinishReason,
            messageMetadata: usage,
          });
          // turn_finish WITHOUT driver.finishTurn — that would set succeeded
          // and gate-open persistence for a mid-flight (suspended) turn.
          activeDriver.usage = usage;
          activeDriver.emitErrorTurnFinish(writer);
          return;
        }
        if (pausedForScopeStepUp) {
          closeReasoning();
          flushSegment();
          finishStep();
          emitFinish(writer, {
            finishReason: "tool-calls" as FinishReason,
            messageMetadata: usage,
          });
          activeDriver.usage = usage;
          activeDriver.emitErrorTurnFinish(writer);
          return;
        }

        // The AI SDK terminal result is authoritative for the final assistant
        // answer + usage. `res.text` settles the complete answer even when the
        // bridge delivered it as a final result rather than streamed
        // `text-delta` parts. Drain it before building the persisted transcript.
        const finalText = await res.text;
        closeReasoning();

        // ENTITLEMENT WALL (external-account harnesses only). Cursor answers a
        // plan-gated request with a normal, successful-looking turn whose whole
        // text is an upgrade notice — so without this check chat would persist
        // it as the assistant's answer and an eval would SCORE it, producing a
        // verdict about a model that never ran. Fail the turn instead. The rule
        // is deliberately narrow (exact text, no successful tool call, plain
        // stop); see `external-account-plan-wall.ts` for why each condition is
        // there and why a substring match would be wrong.
        if (
          externalAccountAuth &&
          isExternalAccountPlanWallTurn({
            finalText,
            finishReason: turnFinishReason,
            successfulToolCalls,
          })
        ) {
          throw externalAccountPlanWallError(harnessAdapter.displayName);
        }

        // Settle cumulative usage + finish reason on the driver NOW — usage is
        // known from the finish part. Set before the completeness fallback below
        // so the synthesized tool step's finishStep() (and every step settling
        // after this point) reports the known cumulative turnUsage, not undefined.
        activeDriver.usage = usage;
        activeDriver.finishReason = turnFinishReason;

        // Completeness reconciliation against the authoritative result: if the
        // live stream yielded no assistant text (answer arrived as a final
        // result, not deltas), the hand-built transcript + UI projection would
        // be blank on an otherwise-successful turn. Project the authoritative
        // `res.text` into both the UI stream and the persisted assistant
        // message so live render + persistence match the terminal result.
        if (
          !emittedAnyText &&
          typeof finalText === "string" &&
          finalText.trim().length > 0
        ) {
          // Final assistant text after tool results begins the next step — flush
          // the pending tool segment FIRST (mirrors the `text-delta` path),
          // otherwise the synthesized text would be appended to the same
          // assistant message as the preceding tool-call, persisting
          // assistant(tool-call + text) → tool instead of the correct
          // assistant(tool-call) → tool → assistant(text) ordering.
          if (pendingResults.length > 0) {
            flushSegment();
            finishStep();
          }
          projectAssistantText(finalText);
        }

        if (!emittedAnyVisiblePart) {
          const streamTypes =
            [...seenHarnessPartTypes].sort().join(",") || "none";
          const finalTextLength =
            typeof finalText === "string" ? finalText.length : 0;
          logger.warn(
            `[harness] completed without visible chat parts; streamTypes=${streamTypes}; finalTextLength=${finalTextLength}`,
          );
          projectAssistantText(HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT);
        }

        // Flush the final step's assistant message + its tool results. Earlier
        // steps were flushed as new assistant content arrived after results, so
        // the persisted history preserves assistant → tool → assistant ordering.
        flushSegment();
        // Final step settles now that usage is known from the finish part.
        finishStep();
        emitFinish(writer, {
          finishReason: turnFinishReason,
          messageMetadata: usage,
        });
        // Shared ritual: write turn_finish + mark success (finish chunk already
        // emitted above).
        activeDriver.finishTurn(writer, { alreadyEmittedFinish: true });
        runSucceeded = true;
        const tStream = Date.now();
        // Values inlined into the message — this logger drops the 2nd arg.
        logger.info(
          `[harness][timing] claim=${tClaim - tStart}ms boxWake=${
            tSandbox - tClaim
          }ms brokerStart=${tBroker - tSandbox}ms sessionConnect=${
            tConnect - tBroker
          }ms modelStream=${tStream - tConnect}ms total=${
            tStream - tStart
          }ms resumed=${resumedSession}`,
        );
        if (localPrepared !== null) {
          // Its own line, with LOCAL-only names.
          //
          // Not folded into the line above, and the names are not reused: the
          // cloud fields mean "reserve and wake an E2B box" and "install an
          // egress transform", and neither happened here. A local turn
          // reporting `boxWake` would be a metric that reads as a box wake and
          // is not one — which is how a dashboard ends up averaging two
          // different things under one name.
          //
          // Durations and a boolean. No path, no machine id, no digest.
          logger.info(
            `[harness][timing][local] runtimeVerify=${
              localPrepared.timings.localRuntimeVerifyMs
            }ms gatewayReady=${
              localPrepared.timings.localGatewayReadyMs
            }ms permissionMode=${localPrepared.permissionMode} resumed=${resumedSession}`,
          );
        }
        if (installedRuntimeVersion) {
          // Its own line, and greppable: the canary alert watches for this
          // value CHANGING between sessions of the same harness, which is not a
          // question the timing line above could answer.
          logger.info(
            `[harness][runtime-version] harness=${harnessAdapter.id} version=${installedRuntimeVersion}`,
          );
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          // Turn-end adoption: sync filesystem-installed skills up into Convex
          // while the session is still LIVE (before detach/destroy below). Only on
          // a clean success — never on abort/error/pausedForApproval — and only
          // for a skills-capable adapter with a healthy fetch (`runtimeSkills`),
          // outside guest/swarm scopes (v1 skips `executionScope`). Fully
          // fail-soft. NOTE: a fresh adoption adds a new skillId to the runtime set
          // NEXT turn, so the runtime fingerprint intentionally forks then (the
          // adapter (re)writes on the fresh start) — expected, not a bug.
          //
          // See `shouldAdoptSandboxSkills` for why each condition is there —
          // in particular why a PINNED turn must never adopt.
          if (
            shouldAdoptSandboxSkills({
              runSucceeded,
              aborted,
              pausedForApproval,
              supportsSkills: harnessAdapter.supportsSkills,
              runtimeSkillsKnown: runtimeSkills !== null,
              skillsArePinned,
              hasExecutionScope: Boolean(executionScope),
              hasCredentials: Boolean(authHeader && projectId),
              hasFileSession: Boolean(sandboxFileSession),
              adoptionDisabled:
                process.env.HARNESS_SKILL_ADOPTION_DISABLED === "1",
            }) &&
            authHeader &&
            projectId &&
            sandboxFileSession
          ) {
            const fileSession = sandboxFileSession;
            const { adopted } = await adoptSandboxSkills({
              session: fileSession,
              authHeader,
              projectId,
              // Names already delivered as cloud skills this turn are the adapter's
              // own dirs — not adoptions.
              managedNames: new Set(deliveredSkills.map((s) => s.name)),
              skillsBase: harnessAdapter.skillsBaseDir,
              // The turn's `abortSignal` bounded nothing here: this branch only
              // runs on a CLEAN success, where that signal is by definition not
              // aborted. Compose it with a deadline so a stalled adoption can't
              // hold the turn open (and a real abort still cancels immediately).
              signal: abortSignal
                ? AbortSignal.any([
                    abortSignal,
                    AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
                  ])
                : AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
            }).catch(() => ({
              adopted: [] as { skillId: string; name: string }[],
            }));
            // Only TRUE 'adopted' dirs become managed (decision 3b): never convert
            // a hand-placed dir into a cloud-deletable cache.
            if (adopted.length > 0) {
              await appendManagedSkills({
                session: fileSession,
                skills: adopted,
                skillsBase: harnessAdapter.skillsBaseDir,
              }).catch(() => {});
            }
          }
          // On a clean turn with continuity: detach to park the live bridge and
          // get a warm resume payload, then BUILD the commit (don't send it
          // here). The commit rides /ingest-chat atomically with the transcript
          // in onFinishEngine so transcript + sidecar advance together. On
          // abort/error: destroy + release the lease.
          if (pausedForApproval && continuity && !aborted) {
            // WS3: keep the runtime/sandbox alive (suspendTurn, NOT stop) and
            // standalone-commit the continuation with awaitingApproval. The
            // commit releases the MCPJam lease (don't hold it across the human
            // decision — it would TTL-expire); the next request re-claims the
            // lane and resumes via continueFrom. No transcript here — the turn
            // is mid-flight (committed via the standalone endpoint, not ingest).
            const continueState = await session.suspendTurn();
            const ok = await commitHarnessSessionState({
              owner: continuity.owner,
              leaseId: continuity.leaseId,
              expectedStateVersion: continuity.stateVersion,
              harnessSessionId: session.sessionId,
              resumeState: continueState,
              computerId,
              runtimeFingerprint,
              awaitingApproval: true,
              bearer: authHeader,
              // Terminal path — bounded. A missed commit means the next request
              // re-claims the lane and starts fresh, which is recoverable;
              // hanging here is not.
              signal: AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
            });
            if (!ok) await releaseHarnessLease?.();
          } else if (runSucceeded && !aborted && continuity) {
            const resumeState = await session.detach();
            capturedHarnessCommit = {
              ownerType: continuity.owner.ownerType as
                | "direct-chat"
                | "scenario-chat"
                | "swarm-chat",
              chatSessionId: continuity.owner.chatSessionId as string,
              ...(continuity.owner.scenarioId
                ? { scenarioId: continuity.owner.scenarioId }
                : {}),
              leaseId: continuity.leaseId,
              expectedStateVersion: continuity.stateVersion,
              harnessId: harnessAdapter.id,
              harnessSessionId: session.sessionId,
              resumeState,
              computerId,
              runtimeFingerprint,
              // Persist only a real (ok:true) hash; omit on failure so the
              // backend keeps the prior stored hash (no empty-hash regression).
              ...(skillsHash !== undefined ? { skillsHash } : {}),
              // Phase 3: the ingest commit re-resolves the guest's own lane.
              ...(executionScope ? { executionScope } : {}),
            };
          } else {
            await session.destroy();
            if (continuity) await releaseHarnessLease?.();
          }
        } catch (finalizeErr) {
          logger.warn(
            "[harness] session finalize failed; releasing lease, sidecar not committed",
            { error: finalizeErr },
          );
          // stop()/destroy() threw → no resume payload to commit. Drop any
          // half-built commit and free the lane so the next turn can claim.
          capturedHarnessCommit = undefined;
          await releaseHarnessLease?.();
        }
      }
    } catch (err) {
      if (effectiveAbortSignal.aborted || isAbortError(err)) {
        aborted = true;
        return;
      }
      const errorText = err instanceof Error ? err.message : String(err);
      // Reporter, not a bare logger.error: the old call captured to Sentry
      // unconditionally and left no typed record (the response is a 200
      // stream the HTTP failure events never see). Classify first, page only
      // on origin=mcpjam, emit route.operation.failed.
      failureReporter({
        message: "[harness] turn failed",
        error: err,
        source: "chat.harness-turn",
        hop: "user_server_hop",
        transport: "http_stream",
        context: { promptIndex },
      });
      // Close any open text block so the UI stream stays balanced.
      closeReasoning();
      if (textId !== undefined) emitTextEnd(writer, textId);
      emitError(writer, errorText);
      // A mid-stream failure still gets a final snapshot + turn_finish so the
      // Trace tab renders what happened (parity with runChatEngineLoop). Guarded
      // by the driver's `traceStarted` so a pre-stream failure emits no phantom
      // turn.
      if (driver?.traceStarted) {
        driver.usage = usage;
        emitTraceSnapshot(
          writer,
          messageHistory,
          toolSetForTrace as unknown as ToolSet,
          driver.snapshotContext(messageHistory),
        );
        driver.emitErrorTurnFinish(writer);
      }
      onEngineError?.({
        message: errorText,
        rawText: errorText,
        promptIndex,
        // This catch covers the WHOLE turn, preparation included: the throws
        // for a missing projectId, a missing auth bearer and disabled broker
        // delivery all land here, and none of them ever reached a model.
        //
        // The flag is set at the HANDOVER, not once the stream is running, so
        // a provider that rejects the request outright still reads as the
        // model's failure rather than ours.
        phase: modelInvoked ? "stream" : "setup",
      });
    } finally {
      stopScopeStepUpBridge();
      stopPolicyBlockBridge();
      stopPolicyBlockPoll();
      // Refusals the harness never surfaced as a result still have to reach the
      // iteration, or the calls the policy prevented look like they never
      // happened.
      drainUnclaimedChannelPolicyBlocks();
      flushHarnessPolicyBlocks();
    }
  };

  // `receiptWriter` is the raw stream writer, passed in only on the ui-sink
  // path. See the `createUIMessageStream` call below for why this now runs from
  // `execute`'s finally rather than the SDK's `onFinish`.
  const onFinishEngine = async (receiptWriter?: ChunkWriter) => {
    clearReservationHeartbeat();
    // Anything not already reported at detection (a turn that ended between a
    // block and its flush) still has to be accounted for.
    flushHarnessPolicyBlocks();
    // Broker teardown runs FIRST — the model stream has ended, so revoke the lease
    // + clear the E2B egress rule before the persistence/cleanup callbacks below,
    // which could hang and would otherwise keep the credential live until TTL/cron.
    // Runs on BOTH stream paths (UI onFinish + inline finally). Idempotent
    // (guarded) + best-effort; a miss is backstopped by lease TTL + the cron.
    //
    // That ordering assumed revoke itself cannot hang, and nothing used to
    // enforce it — the call passed no signal, so a stalled backend parked this
    // await forever and took the whole turn's teardown with it. The deadline
    // below is what makes the assumption true.
    // LOCAL teardown runs first, and for the same reason the broker revoke does:
    // the model stream has ended, so the gateway must stop serving, the lease
    // must be revoked, and the supervised tree must be stopped BEFORE the
    // persistence callbacks below, which could hang and would otherwise leave a
    // live credential and a running agent behind them.
    //
    // Idempotent by construction (`onceAsync` in `local-turn.ts`), so the abort
    // path and this one can both call it without either having to know whether
    // the other did. Bounded, because a stop that hangs must not take the whole
    // turn's teardown with it — the same lesson the revoke deadline below
    // encodes.
    if (localTeardown) {
      const teardown = localTeardown;
      localTeardown = null;
      await Promise.race([
        teardown(),
        new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, HARNESS_TEARDOWN_TIMEOUT_MS).unref?.(),
        ),
      ]).catch(() => {});
    }
    if (!brokerRevoked && brokerRunId && authHeader) {
      brokerRevoked = true;
      // `runId` alone. The backend resolves the box to clear from the LEASE it
      // revokes, never from a caller-supplied id — it always ignored the
      // `computerId` we used to send, and with two kinds of box now possible,
      // sending a sandbox row id under that name would be a lie the reader has
      // to unpick.
      await revokeHarnessModelBroker({
        runId: brokerRunId,
        ...(projectId ? { projectId } : {}),
        bearer: authHeader,
        signal: AbortSignal.timeout(HARNESS_TEARDOWN_TIMEOUT_MS),
      }).catch(() => {});
    }
    // The box was claimed but never leased — preparation failed, or the turn was
    // aborted during it. Hand the box back now; the reservation's TTL would
    // otherwise make the next turn wait minutes for a box nobody is using.
    // Reaching here with the claim still held means no lease exists, so there is
    // no egress rule to clear and nothing else to undo.
    if (reservationHeld && releaseBoxReservation) {
      reservationHeld = false;
      await releaseBoxReservation();
    }
    if ((runSucceeded || pausedForScopeStepUp) && !aborted && driver) {
      // Stream start (matches the span offset base) so rehydrated traces align
      // with the live ones — see traceBaseMs.
      const trace: PersistedTurnTrace = driver.buildPersistedTrace();
      capturedTurnTrace = trace;
      // §3: hand the resume-state commit to onConversationComplete so it rides
      // /ingest-chat atomically with the transcript. On success the backend
      // commit releases the lease; if persistence is absent or fails, the
      // sidecar did NOT advance — release the lane best-effort.
      let persistOk = false;
      try {
        const persistOutcome = await onConversationComplete?.(
          [...messageHistory],
          trace,
          runSucceeded ? capturedHarnessCommit : undefined,
        );
        // The callback RESOLVING is not the same as the turn being saved. Now
        // that it reports an outcome, a `failed`/`skipped`/`conflict` result
        // resolves normally — treating that as success would leave the harness
        // lease held against a sidecar commit that never landed. Only an actual
        // commit (or a recognized duplicate of one) counts; everything else
        // takes the same release path a thrown persist does.
        persistOk =
          !onConversationComplete ||
          persistOutcome === undefined ||
          persistOutcome.outcome === "saved" ||
          persistOutcome.outcome === "duplicate";
        if (persistOutcome && chatSessionId) {
          writePersistReceipt(receiptWriter, persistOutcome, {
            chatSessionId,
            turnId: trace.turnId,
          });
        }
      } catch (persistErr) {
        logger.error("[harness] onConversationComplete failed", persistErr);
      }
      if (
        runSucceeded &&
        capturedHarnessCommit &&
        (!onConversationComplete || !persistOk)
      ) {
        await releaseHarnessLease?.();
      }
    }
    // Pre-session cleanup: if the session was never established (the turn failed
    // or aborted after claimHarnessSessionState but before createSession — sandbox
    // wake, broker start, runtime/agent construction, or createSession threw), no
    // finalizer owns the claimed lane, so free it here or the next chat turn is
    // blocked with "Another turn is already running" until the lease TTL. This runs
    // on BOTH stream paths (UI onFinish + inline finally). Idempotent, and a no-op
    // on non-continuity turns (releaseHarnessLease is undefined).
    if (!sessionEstablished) {
      await releaseHarnessLease?.();
    }
    // Mirror the emulated engine (mcpjam-stream-handler.ts): a cleanup/teardown
    // error must not reject stream finalization after an otherwise successful
    // turn (the trace + onConversationComplete already ran above).
    try {
      await onStreamComplete?.();
    } catch (cleanupError) {
      logger.error(
        "[harness] error while running stream cleanup",
        cleanupError,
      );
    }
  };

  if (streamSink === "ui") {
    const stream = createUIMessageStream({
      // Run finalization from `execute`'s finally rather than the SDK's
      // `onFinish`, mirroring the emulated engine (mcpjam-stream-handler.ts).
      // Two reasons: `onFinish` runs with no writer, so the persist receipt
      // could never be emitted from there; and passing the callback at all
      // enables the SDK's own message-state reducer, which the emulated engine
      // had to abandon because it throws on cross-response tool parts.
      // `onFinishEngine` never consumed the reducer's argument, so this is a
      // strict reduction in exposure.
      execute: async (context) => {
        try {
          await executeEngine(context);
        } finally {
          await onFinishEngine(context.writer);
        }
      },
    });
    const response = createUIMessageStreamResponse({ stream });
    return { response, messageHistory, aborted: false };
  }

  // streamSink === "none": run inline against a no-op writer; trace +
  // onConversationComplete still fire via closures.
  const noopWriter: ChunkWriter = { write: () => {} };
  try {
    await executeEngine({ writer: noopWriter });
  } finally {
    // onFinishEngine runs the broker teardown for this path too (see above).
    await onFinishEngine();
  }
  return {
    messageHistory,
    aborted,
    ...(capturedTurnTrace ? { turnTrace: capturedTurnTrace } : {}),
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}
