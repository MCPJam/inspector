/**
 * `resolveTurnRuntime` — the shared runtime adapter that turns a chatbox's
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
 * Per-run attribution stamped onto the resulting usage record. Exactly one of
 * `synthesisRunId` (chatbox session simulation) / `journeyRunId` (swarm) is
 * set; today only `synthesisRunId` is wired. Kept as a closed XOR so a caller
 * can't accidentally stamp both onto one spend row.
 */
export type TurnRunAttribution =
  | { synthesisRunId: string; journeyRunId?: never }
  | { journeyRunId: string; synthesisRunId?: never }
  | undefined;

/**
 * The narrowed source-of-traffic marker forwarded into chat-ingestion /
 * usage writeback. Mirrors `RunAssistantTurnOptions["sourceType"]`.
 */
export type TurnSourceType = "direct" | "chatbox" | "eval";

export interface ResolveTurnRuntimeArgs {
  modelDefinition: ModelDefinition;
  projectId: string;
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  /** Selected MCP server ids — flow into the byok body + local-usage body. */
  serverIds?: string[];
  /** Narrowed source marker (chatbox for synthetic). Used for local-usage. */
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
 */
export function classifyTurnFailure(
  message: string,
): "rate_limited" | "failed" {
  return /rate.?limit|spend|cap/i.test(message) ? "rate_limited" : "failed";
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
    chatboxId: args.chatboxId,
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
        "Synthetic runs on local-runtime org BYOK models don't yet support approval-required tool calls. Disable tool approval on this chatbox or switch the provider to cloud runtime.",
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
        chatboxId: args.chatboxId,
        accessVersion: args.accessVersion,
        selectedServers: args.serverIds,
        serverIds: args.serverIds,
        synthesisRunId: args.attribution?.synthesisRunId,
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
