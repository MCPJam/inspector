/**
 * `resolveTurnRuntime` — the shared runtime adapter that turns a scenario's
 * `ModelDefinition` (+ auth/attribution context) into a concrete
 * {@link TurnRuntime} for {@link runUnifiedAssistantTurn}, plus the three
 * side-concerns that live alongside runtime selection:
 *
 *   1. provider/runtime resolution   (`resolveSyntheticModelSource`)
 *   2. local-BYOK usage writeback     (`finalizeUsage` → `postLocalUsage`)
 *   3. approval guard + failure class (`classifyFailure`)
 *
 * This is the extraction of everything `drainAssistantTurn` used to do
 * "up to the point of calling the engine" so the swarm/synthetic paths and
 * the eventual chat/eval migrations can share ONE resolution+writeback
 * surface instead of re-deriving the three-way MCPJam / cloud-BYOK /
 * local-BYOK decision inline.
 *
 * Byte-parity contract (load-bearing — this sits on a spend-metered hot path):
 *   - MCPJam  → hosted `/stream`      (default endpoint, no providerKey).
 *   - cloud BYOK → hosted `/stream/org` with `extraBodyFields:{ providerKey,
 *     serverIds }` — byte-matching `handleHostedOrgChatModel`.
 *   - local BYOK → direct engine (model built via `buildOrgModelFromResolvedConfig`)
 *     and `finalizeUsage` posts `/stream/org/local-usage` with the identical
 *     body `runLocalOrgChatTurnHeadless`'s `postLocalUsage` emitted.
 *   - external account → REFUSED. A runtime-chosen sentinel (`cursor/auto`)
 *     never asks the org-provider config a question, and it never runs here
 *     either: the runtime authenticates with the customer's own vendor
 *     credential, which reaches `runHarnessTurn` only through the caller's
 *     materialized project secrets — a seam `runUnifiedAssistantTurn` does not
 *     have. See the branch for what wiring it would take.
 */

import type { ToolSet } from "ai";
import type { Harness } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import {
  assertOrgModelAllowed,
  buildOrgModelFromResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import {
  resolveSyntheticModelSource,
  type SyntheticModelSource,
} from "./org-model-config.js";
import { postLocalUsage } from "./org-model-stream-handler.js";
import { logger } from "./logger.js";
import type {
  DirectRuntime,
  TurnRuntime,
  UnifiedTurnResult,
} from "./turn-execution.js";

/**
 * Per-run attribution stamped onto the resulting usage record. `journeyRunId`
 * ties spend to a swarm (journey-execution) run; absent for real chat.
 * (The scenario session-simulation arm — `synthesisRunId` — was removed with
 * the scenario synthetic surface.)
 */
export type TurnRunAttribution = { journeyRunId: string } | undefined;

/**
 * The narrowed source-of-traffic marker forwarded into chat-ingestion /
 * usage writeback. Mirrors `RunAssistantTurnOptions["sourceType"]`.
 */
export type TurnSourceType = "direct" | "scenario" | "eval" | "swarm";

export interface ResolveTurnRuntimeArgs {
  modelDefinition: ModelDefinition;
  projectId: string;
  authHeader?: string;
  scenarioId?: string;
  accessVersion?: number;
  /** Selected MCP server ids — flow into the byok body + local-usage body. */
  serverIds?: string[];
  /** Narrowed source marker (scenario for synthetic). Used for local-usage. */
  sourceType: TurnSourceType;
  chatSessionId?: string;
  /**
   * Local-runtime approval guard inputs: a non-empty `tools` set with
   * `requireToolApproval === true` is refused up-front (the local turn driver
   * has no approval loop yet).
   */
  requireToolApproval?: boolean;
  tools?: ToolSet;
  /** Harness selector — carried onto the hosted runtime (Omitted from HostedTurnOptions). */
  harness?: Harness;
  /**
   * Caller-supplied extra `/stream` body fields (e.g. forwarded synthesis
   * attribution the engine appends). Merged UNDER the byok sibling fields
   * (providerKey/serverIds win on collision) exactly like today.
   */
  extraBodyFields?: Record<string, unknown>;
  /** Per-run attribution stamped onto the local-BYOK usage record. */
  attribution?: TurnRunAttribution;
}

export interface ResolvedTurnRuntime {
  runtime: TurnRuntime;
  modelSource: SyntheticModelSource;
  /**
   * Local-BYOK usage writeback. No-op for the hosted engines (the backend
   * records usage server-side). Invoke on any NON-ABORTED completion —
   * engine-error included, so consumed tokens are still billed — mirroring the
   * old `buildLocalOrgOnPersist`, which billed unconditionally on non-abort.
   * Self-guards on `result.aborted`, and the writeback itself is best-effort
   * (a telemetry outage is swallowed + logged, never thrown).
   */
  finalizeUsage(result: UnifiedTurnResult): Promise<void>;
  /** Map a turn-failure message to the runner's rate-limit vs failed outcome. */
  classifyFailure(message: string): "rate_limited" | "failed";
}

/**
 * The single source of truth for folding spend-cap / rate-limit errors into
 * the amber `rate_limited` outcome vs a hard `failed`. Both `runOneSession`'s
 * catch AND the per-runtime `classifyFailure` delegate here so the regex can't
 * drift between the two call sites.
 *
 * Matches provider rate-limits (`rate limit`, a literal `429` or "too many
 * requests" — the local-BYOK path attaches no code or status, so prose is all
 * that survives) AND org spend-cap wording (`spend`, `cap`, `quota`,
 * `budget`) — an org cap surfaced as "quota exceeded" / "budget exhausted"
 * must land in `rate_limited` so the swarm fan-out's whole-run stop can fire
 * on it (it re-inspects the message via `classifyRateLimit`).
 * `cap`/`quota`/`budget` are word-anchored so genuine spend-cap wording
 * matches but "capacity", "recap", "escape" do NOT (a provider capacity error
 * is a hard `failed`, not a spend cap). A bare `429` is likewise anchored, so
 * a port or id containing those digits is not read as a rate-limit.
 */
export function classifyTurnFailure(
  message: string,
): "rate_limited" | "failed" {
  return /rate.?limit|too many requests|\b429\b|spend|\bquota\b|\bbudget\b|\bcap\b/i.test(
    message,
  )
    ? "rate_limited"
    : "failed";
}

const HOSTED_NOOP_FINALIZE = async (): Promise<void> => {
  // Hosted engines (MCPJam `/stream`, cloud BYOK `/stream/org`) record usage
  // server-side; the inspector never posts local-usage for them. This mirrors
  // today's dispatch, where only the local-runtime branch called postLocalUsage.
};

export async function resolveTurnRuntime(
  args: ResolveTurnRuntimeArgs,
): Promise<ResolvedTurnRuntime> {
  const modelId = String(args.modelDefinition.id);

  // Classify once — the SAME resolver the empty-session fallback persist uses,
  // so the two attribution paths can't drift.
  const resolution = await resolveSyntheticModelSource({
    modelDefinition: args.modelDefinition,
    projectId: args.projectId,
    authHeader: args.authHeader,
    scenarioId: args.scenarioId,
    accessVersion: args.accessVersion,
    serverIds: args.serverIds,
  });

  // --- Local-runtime org BYOK → direct engine ---
  if (
    resolution.source !== "mcpjam" &&
    resolution.orgRuntime?.runtimeLocation === "local"
  ) {
    const orgRuntime = resolution.orgRuntime;

    // Local-runtime org providers have no approval loop yet — the direct turn
    // driver can't pause for a human, and a synthetic visitor can't approve.
    // Refuse up-front with the SAME message the synthetic dispatch used before
    // this extraction (this guard fired first, before the model was built).
    if (
      args.requireToolApproval === true &&
      args.tools &&
      Object.keys(args.tools as Record<string, unknown>).length > 0
    ) {
      throw new Error(
        "Synthetic runs on local-runtime org BYOK models don't yet support approval-required tool calls. Disable tool approval on this scenario or switch the provider to cloud runtime.",
      );
    }

    // Same validation + build the SSE/headless local handlers run.
    assertOrgModelAllowed(orgRuntime.provider, modelId);
    const llmModel = buildOrgModelFromResolvedConfig(orgRuntime.provider, modelId);

    const runtime: DirectRuntime = {
      kind: "direct",
      // Bridge the AI-SDK `LanguageModel` union to the engine's narrower
      // `createLlmModel` return — the same cast the local handlers use.
      llmModel: llmModel as unknown as DirectRuntime["llmModel"],
      modelId,
      // NOTE: intentionally NO `provider`. `runLocalOrgChatTurnHeadless` never
      // forwarded a provider string to `runDirectChatTurn`, so its llm/step
      // spans carried no `gen_ai.provider.name`. Setting it here would change
      // the persisted trace spans, so we omit it to keep byte-parity.
    };

    const providerKey = orgRuntime.provider.providerKey;
    const finalizeUsage = async (result: UnifiedTurnResult): Promise<void> => {
      // Bill on any NON-ABORTED completion, engine-error included: the old
      // `postLocalUsage` fired unconditionally on non-abort and billed the
      // consumed tokens even when the turn errored mid-stream. The caller
      // invokes this BEFORE throwing on an engine error, so a failed turn's
      // real spend is still recorded. Only abort suppresses the writeback.
      if (result.aborted) return;
      // FIRE-AND-FORGET — exact parity with the OLD call site
      // (`postLocalUsage({...}).catch((err) => logger.warn(...))`, never
      // awaited). Awaiting the writeback would block the turn for up to the 5s
      // fetch timeout during a `/stream/org/local-usage` outage and, on reject,
      // fail an otherwise-successful synthetic turn. The `.catch` swallows +
      // logs so there's no unhandled rejection; billing telemetry must neither
      // gate nor slow the turn. The request is still ISSUED, so consumed tokens
      // (incl. on a mid-stream engine error) are billed.
      void postLocalUsage({
        projectId: args.projectId,
        providerKey,
        model: modelId,
        usage: result.usage,
        finishReason: result.finishReason,
        chatSessionId: args.chatSessionId,
        sourceType: args.sourceType,
        // Byte-parity: the old writeback stamped turnId + promptIndex from the
        // turn trace. The direct engine always produces a trace on completion.
        turnId: result.turnTrace?.turnId,
        promptIndex: result.turnTrace?.promptIndex,
        authHeader: args.authHeader,
        scenarioId: args.scenarioId,
        accessVersion: args.accessVersion,
        selectedServers: args.serverIds,
        serverIds: args.serverIds,
        journeyRunId: args.attribution?.journeyRunId,
      }).catch((err) => {
        logger.warn("[org/local] Failed to post local usage", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    return {
      runtime,
      modelSource: "local_byok",
      finalizeUsage,
      classifyFailure: classifyTurnFailure,
    };
  }

  // --- Runtime-chosen sentinel → REFUSED on this surface ---
  //
  // The host's model id names no provider model (`cursor/auto`), so there is no
  // org provider to resolve and no MCPJam credential to spend. That much is
  // what `resolveSyntheticModelSource` already decided; what is left is whether
  // this resolver's callers can actually RUN such a turn, and none of them can.
  //
  // Both refusals happen BEFORE the caller marks the turn as possibly-spent, so
  // a v1 session turn that named `cursor/auto` releases its lease and gets a
  // sentence that explains itself — where it previously reached Convex and came
  // back `provider_not_configured: cursor`, i.e. "go configure a key" for a
  // provider that has no keys.
  //
  // WITHOUT a harness the sentinel is unrunnable by construction: nothing else
  // reaches the runtime that would choose the model.
  //
  // WITH a harness it is unrunnable HERE, and the difference matters enough to
  // say separately. An external-account runtime authenticates with the
  // customer's own vendor credential, and `runHarnessTurn` takes that credential
  // from ONE place — the caller's materialized project secrets
  // (`runtimeSecretsOverride`), because delivering a value into the box and
  // scrubbing it out of the persisted transcript are two uses of one list and
  // only the caller can wire the second. `runUnifiedAssistantTurn` — the facade
  // every caller of this resolver drives — has no `runtimeSecrets` seam at all,
  // so the credential cannot arrive. Returning a "hosted + harness" runtime here
  // would advertise a turn that then dies inside `runHarnessTurn` telling the
  // user to add a `CURSOR_API_KEY` secret they may well have already added — a
  // wrong diagnosis for a turn this surface was never able to run.
  //
  // The fix is not a bigger error message: it is wiring the secrets fetch AND
  // the transcript scrubber into the synthetic runner, which would also start
  // delivering project secrets to the existing harnesses' synthetic turns
  // (today they receive none). That is a security-relevant change with its own
  // review; see the matching note in `run-harness-turn.ts`. Until then, refuse.
  if (resolution.source === "external-account") {
    throw new Error(
      args.harness
        ? `"${modelId}" is a placeholder for a runtime that reaches its model ` +
            "on your own account with the runtime vendor, and this turn " +
            "surface cannot deliver that credential — it has no path for the " +
            "project secrets the runtime authenticates with. Run this host " +
            "from chat, which materializes them."
        : `"${modelId}" is a placeholder for a runtime that chooses its own ` +
            "model, not a model MCPJam can run. Send this turn to a host " +
            "whose harness provides that runtime, or pick a real model.",
    );
  }

  // --- MCPJam-provided → hosted `/stream` ---
  if (resolution.source === "mcpjam") {
    return {
      runtime: {
        kind: "hosted",
        // `runAssistantTurn`'s default endpoint. The old MCPJam branch did NOT
        // set endpointPath; `resolvedEndpointPath = endpointPath ?? "/stream"`
        // makes passing "/stream" explicitly byte-identical on the wire.
        endpointPath: "/stream",
        ...(args.extraBodyFields ? { extraBodyFields: args.extraBodyFields } : {}),
        ...(args.harness ? { harness: args.harness } : {}),
      },
      modelSource: "mcpjam",
      finalizeUsage: HOSTED_NOOP_FINALIZE,
      classifyFailure: classifyTurnFailure,
    };
  }

  // --- Cloud-runtime org BYOK → hosted `/stream/org` ---
  // `resolution.orgRuntime` is guaranteed defined for non-"mcpjam" sources and
  // is the cloud shape here (local was handled above).
  const providerKey =
    resolution.orgRuntime?.runtimeLocation === "cloud"
      ? resolution.orgRuntime.providerKey
      : undefined;
  if (providerKey === undefined) {
    // Defensive: an unexpected runtime shape (neither local nor cloud) — the
    // old dispatcher fell through to the engine branch, which would then fail
    // opaquely. Surface it as a clear error instead.
    throw new Error(
      "Turn runtime resolution returned an unexpected org runtime shape (no cloud providerKey)",
    );
  }

  return {
    runtime: {
      kind: "hosted",
      endpointPath: "/stream/org",
      // Byte-match `handleHostedOrgChatModel`: caller fields first, then the
      // sibling fields (providerKey, serverIds) that own the hosted contract.
      extraBodyFields: {
        ...(args.extraBodyFields ?? {}),
        providerKey,
        ...(args.serverIds?.length ? { serverIds: args.serverIds } : {}),
      },
      ...(args.harness ? { harness: args.harness } : {}),
    },
    modelSource: "byok",
    finalizeUsage: HOSTED_NOOP_FINALIZE,
    classifyFailure: classifyTurnFailure,
  };
}
