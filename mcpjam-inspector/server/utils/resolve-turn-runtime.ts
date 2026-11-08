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
 *   - external account → a hosted harness turn on the organization's own
 *     vendor key, for swarm and eval runs only; refused for every other
 *     caller. A runtime-chosen sentinel (`cursor/auto`) never asks the
 *     org-provider config a question.
 */

import { modelWorkloadFor } from "./model-workload.js";
import type { ToolSet } from "ai";
import type { Harness, RequestedModelSelection } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import {
  assertOrgModelAllowed,
  buildOrgModelFromResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import {
  resolveSyntheticModelSource,
  type SyntheticModelSource,
} from "./org-model-config.js";
import { admitEachLocalOrgAttempt } from "./local-org-attempt-admission.js";
import { postLocalUsage } from "./org-model-stream-handler.js";
import { classifyTurnFailure } from "./turn-failure-classification.js";
import { logger } from "./logger.js";
import { harnessOrgProviderUnsupportedReason } from "@/shared/harness-model-support";
import {
  orgKeyHarnessSurfaceRefusal,
  runsOnOrgVendorKey,
} from "./harness/org-key-surfaces.js";
import { buildLocalExecutionRecord, type LocalExecutionAttempt } from "./local-execution-record.js";
import {
  backendModelSelection,
  ModelResolutionRefusalError,
} from "./model-resolution-local.js";
import { forwardableSelection } from "./selection-rail.js";
import {
  reasoningEffortProviderOptions,
  type EffectiveModelSettings,
} from "./model-selection-settings.js";
import type {
  DirectRuntime,
  TurnRuntime,
  UnifiedTurnResult,
} from "./turn-execution.js";

/**
 * Per-run attribution stamped onto the resulting usage record. `journeyRunId`
 * ties spend to a swarm (journey-execution) run; `eventRunId` to an MCP Events
 * trigger run, whose daily spend cap the backend charges from that record.
 * Both absent for real chat. (The scenario session-simulation arm —
 * `synthesisRunId` — was removed with the scenario synthetic surface.)
 */
export type TurnRunAttribution =
  | { journeyRunId?: string; eventRunId?: string }
  | undefined;

/**
 * The narrowed source-of-traffic marker forwarded into chat-ingestion /
 * usage writeback. Mirrors `RunAssistantTurnOptions["sourceType"]`.
 */
export type TurnSourceType = "direct" | "scenario" | "eval" | "swarm" | "event";

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
  /** Effective input transcript, used only to derive image admission. */
  messages?: unknown;
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
  /**
   * The saved selection behind `modelDefinition`. It DECIDES THE RAIL
   * (`decideTurnRail`, `selection-rail.ts`):
   *
   *   - `hosted` → MCPJam `/stream`;
   *   - `org` → the org connection (`/stream/org`, or its local runtime);
   *   - `local` and a STORED legacy selection → the own-key path (the org's
   *     connection for the model's provider), never MCPJam credits — this
   *     surface holds no key of the caller's own machine;
   *   - absent → today's hosted-list check, unchanged.
   *
   * Sent as the body's `modelSelection` only on the rail it names: a `hosted`
   * one on `/stream`, an `org` one on `/stream/org` and `/stream/org/resolve`
   * (validated first). The backend re-resolves it and records it as the
   * requested selection. A `local` or legacy one is never sent.
   */
  modelSelection?: RequestedModelSelection;
  modelSelectionOrigin?: "backfill";
  /**
   * Per-step output-token ceiling for an MCPJam-hosted step (`/stream`): the
   * backend holds credits against it. Sent on that rail ONLY, and never to a
   * harness host (its model broker clamps `max_tokens` without touching the
   * thinking budget). Nothing in this repo shows `/stream/org` or the direct
   * engine reading it, so a BYOK turn keeps its own limits.
   */
  maxOutputTokens?: number;
  /**
   * The settings this turn runs with, already resolved once by
   * `resolveEffectiveModelSettings` (per-run override > saved selection >
   * host defaults). `temperature` is what the caller hands the engine; a
   * `reasoningEffort` is applied HERE, where the rail is known: provider
   * options on the direct engine, the forwarded selection on `/stream`, and the
   * selection (or a top-level field) on `/stream/org`, which maps it per org
   * provider. Both are recorded
   * on the local-runtime execution record.
   */
  settings?: EffectiveModelSettings;
}

/** How the turn ended, for the local-runtime execution record. */
export type TurnUsageOutcome = {
  /** The engine's terminal error, when the turn failed mid-stream. */
  engineError?: { message: string };
};

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
  finalizeUsage(
    result: UnifiedTurnResult,
    outcome?: TurnUsageOutcome,
  ): Promise<void>;
  /** Map a turn-failure message to the runner's rate-limit vs failed outcome. */
  classifyFailure(message: string): "rate_limited" | "failed";
}

// Re-exported because this is where every existing importer looks for it; the
// definition moved to a leaf module so callers that want only this predicate
// need not load the model factories behind this one.
export { classifyTurnFailure } from "./turn-failure-classification.js";

/**
 * The callers here whose harness turns may run on the organization's vendor
 * key. This resolver's `direct` callers are the v1 APIs, never the Playground.
 */
const ORG_KEY_HARNESS_SOURCES: ReadonlySet<TurnSourceType> = new Set([
  "swarm",
  "eval",
]);

const HOSTED_NOOP_FINALIZE = async (): Promise<void> => {
  // Hosted engines (MCPJam `/stream`, cloud BYOK `/stream/org`) record usage
  // server-side; the inspector never posts local-usage for them. This mirrors
  // today's dispatch, where only the local-runtime branch called postLocalUsage.
};

export async function resolveTurnRuntime(
  args: ResolveTurnRuntimeArgs,
): Promise<ResolvedTurnRuntime> {
  const modelId = String(args.modelDefinition.id);

  // A harness on the organization's vendor key (Cursor) runs only on swarm and
  // eval runs here, whose boxes receive the key. The v1 APIs, MCP Events and
  // User Testing session simulation are refused whatever the model, before
  // anything is resolved and before the caller marks the turn possibly-spent.
  if (
    args.harness &&
    runsOnOrgVendorKey(args.harness) &&
    !ORG_KEY_HARNESS_SOURCES.has(args.sourceType)
  ) {
    throw new Error(
      orgKeyHarnessSurfaceRefusal(
        args.harness,
        args.sourceType === "scenario" ? "study" : "elsewhere",
      ),
    );
  }

  // Classify once — the SAME resolver the empty-session fallback persist uses,
  // so the two attribution paths can't drift.
  const resolution = await resolveSyntheticModelSource({
    modelDefinition: args.modelDefinition,
    projectId: args.projectId,
    authHeader: args.authHeader,
    scenarioId: args.scenarioId,
    accessVersion: args.accessVersion,
    serverIds: args.serverIds,
    modelWorkload: modelWorkloadFor(args),
    // The WHOLE selection: it decides the source, and the resolver forwards
    // only an `org` one to `/stream/org/resolve`.
    ...(args.modelSelection ? { modelSelection: args.modelSelection } : {}),
  });
  // Validated (and normalized) before it rides on any body; a `local` or
  // legacy selection is never forwarded.
  const forwarded = backendModelSelection(
    forwardableSelection(args.modelSelection),
  );
  const hostedSelection =
    forwarded?.source === "hosted" ? forwarded : undefined;
  const orgSelection = forwarded?.source === "org" ? forwarded : undefined;

  // --- Local-runtime org BYOK → direct engine ---
  if (
    resolution.source !== "mcpjam" &&
    resolution.orgRuntime?.runtimeLocation === "local"
  ) {
    const orgRuntime = resolution.orgRuntime;

    // A HARNESS host never runs on the direct engine. This branch drops
    // `harness` on the floor — the turn would run the emulated direct engine on
    // the org's local key and be reported under the harness's name. Refused
    // using shared copy that makes no assumption about organization policy.
    if (args.harness) {
      throw new Error(harnessOrgProviderUnsupportedReason(args.harness, null));
    }

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

    // Same validation + build the SSE/headless local handlers run. Each
    // provider attempt (every step, every retry) asks the backend first.
    assertOrgModelAllowed(orgRuntime.provider, modelId);
    const attempts: LocalExecutionAttempt[] = [];
    const llmModel = admitEachLocalOrgAttempt(
      buildOrgModelFromResolvedConfig(orgRuntime.provider, modelId),
      orgRuntime.admission,
      modelId,
      attempts,
    );

    // The inspector calls the provider, so the effort is applied here, as
    // provider options, or refused when this provider has no effort control.
    const effort = args.settings?.reasoningEffort;
    const providerOptions = effort
      ? reasoningEffortProviderOptions({
          providerKey: orgRuntime.provider.providerKey,
          modelId: args.modelSelection?.modelId ?? modelId,
          effort,
        })
      : undefined;
    if (effort && !providerOptions) {
      throw new ModelResolutionRefusalError([
        {
          code: "capability_missing",
          reason: `reasoning effort "${effort}" is not supported for ${modelId} on the ${orgRuntime.provider.providerKey} connection`,
          evidence: {
            setting: "reasoningEffort",
            providerKey: orgRuntime.provider.providerKey,
          },
        },
      ]);
    }

    const runtime: DirectRuntime = {
      kind: "direct",
      // Bridge the AI-SDK `LanguageModel` union to the engine's narrower
      // `createLlmModel` return — the same cast the local handlers use.
      llmModel: llmModel as unknown as DirectRuntime["llmModel"],
      modelId,
      ...(providerOptions ? { providerOptions } : {}),
      // NOTE: intentionally NO `provider`. `runLocalOrgChatTurnHeadless` never
      // forwarded a provider string to `runDirectChatTurn`, so its llm/step
      // spans carried no `gen_ai.provider.name`. Setting it here would change
      // the persisted trace spans, so we omit it to keep byte-parity.
    };

    const providerKey = orgRuntime.provider.providerKey;
    const finalizeUsage = async (
      result: UnifiedTurnResult,
      outcome?: TurnUsageOutcome,
    ): Promise<void> => {
      // Bill on any NON-ABORTED completion, engine-error included: the old
      // `postLocalUsage` fired unconditionally on non-abort and billed the
      // consumed tokens even when the turn errored mid-stream. The caller
      // invokes this BEFORE throwing on an engine error, so a failed turn's
      // real spend is still recorded. Only abort suppresses the writeback.
      if (result.aborted) return;
      // Provenance for a turn that ran under a saved org selection: what was
      // requested (the selection), what ran (this connection's local rail,
      // this wire id, these settings) and how the call ended. The backend
      // checks it against its own resolution of the same selection.
      const execution = buildLocalExecutionRecord({
        selection: orgSelection,
        attempts,
        origin: args.modelSelectionOrigin,
        providerKey,
        wireModelId: modelId,
        effectiveSettings: {
          ...(args.settings?.temperature !== undefined
            ? { temperature: args.settings.temperature }
            : {}),
          ...(providerOptions && effort ? { reasoningEffort: effort } : {}),
        },
        outcome: outcome?.engineError
          ? {
              kind: "error",
              code:
                classifyTurnFailure(outcome.engineError.message) ===
                "rate_limited"
                  ? "rate_limited"
                  : "provider_error",
            }
          : { kind: "ok" },
        at: Date.now(),
      });
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
        eventRunId: args.attribution?.eventRunId,
        ...(orgSelection && execution
          ? { modelSelection: orgSelection, modelSelectionOrigin: args.modelSelectionOrigin, execution }
          : {}),
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

  // --- Runtime-chosen sentinel: a harness on the org's own key, or refused ---
  //
  // The host's model id names no provider model (`cursor/auto`): the runtime
  // reaches its model on the organization's own vendor account, so there is no
  // org provider to resolve and no MCPJam credential to spend.
  //
  // Only the harness that chooses the model can run it, and only on a source
  // the check above admitted (`runHarnessTurn` then refuses a turn whose org
  // has no ready key). WITHOUT that harness the sentinel is unrunnable by
  // construction: nothing else reaches the runtime that would choose.
  if (resolution.source === "external-account") {
    if (args.harness && runsOnOrgVendorKey(args.harness)) {
      return {
        runtime: {
          kind: "hosted",
          modelSelectionOrigin: args.modelSelectionOrigin,
          // Inert for a harness turn, which never calls a `/stream` model.
          endpointPath: "/stream",
          ...(args.extraBodyFields
            ? { extraBodyFields: args.extraBodyFields }
            : {}),
          harness: args.harness,
        },
        modelSource: "external-account",
        finalizeUsage: HOSTED_NOOP_FINALIZE,
        classifyFailure: classifyTurnFailure,
      };
    }
    throw new Error(
      `"${modelId}" is a placeholder for a runtime that chooses its own ` +
        "model, not a model MCPJam can run. Send this turn to a host " +
        "whose harness provides that runtime, or pick a real model.",
    );
  }

  // --- MCPJam-provided → hosted `/stream` ---
  if (resolution.source === "mcpjam") {
    // `/stream` applies a reasoning effort from the forwarded selection, or the
    // top-level `reasoningEffort` field, which it prefers. A per-run effort the
    // selection does not carry (a chat turn's own, an override) rides as that
    // field instead of being refused.
    const effort = args.settings?.reasoningEffort;
    const topLevelEffort =
      effort && hostedSelection?.settings?.reasoningEffort !== effort
        ? { reasoningEffort: effort }
        : undefined;
    // Never for a harness host: its model broker clamps `max_tokens` to a
    // ceiling without touching the model's thinking budget, so one below the
    // broker's own default can make every thinking turn fail. Held here, where
    // the body is built, rather than left to whatever `runHarnessTurn` happens
    // to read out of `extraBodyFields` today.
    const outputCeiling = args.harness ? undefined : args.maxOutputTokens;
    const hostedExtraBodyFields =
      args.extraBodyFields ||
      hostedSelection ||
      topLevelEffort ||
      outputCeiling !== undefined
        ? {
            ...(args.extraBodyFields ?? {}),
            ...(outputCeiling !== undefined
              ? { maxOutputTokens: outputCeiling }
              : {}),
            ...(hostedSelection ? { modelSelection: hostedSelection, modelSelectionOrigin: args.modelSelectionOrigin } : {}),
            ...(topLevelEffort ?? {}),
          }
        : undefined;
    return {
      runtime: {
        kind: "hosted",
        modelSelectionOrigin: args.modelSelectionOrigin,
        // `runAssistantTurn`'s default endpoint. The old MCPJam branch did NOT
        // set endpointPath; `resolvedEndpointPath = endpointPath ?? "/stream"`
        // makes passing "/stream" explicitly byte-identical on the wire.
        endpointPath: "/stream",
        ...(hostedExtraBodyFields
          ? { extraBodyFields: hostedExtraBodyFields }
          : {}),
        ...(args.harness ? { harness: args.harness } : {}),
        ...(args.harness && hostedSelection
          ? { modelSelection: hostedSelection }
          : {}),
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
      modelSelectionOrigin: args.modelSelectionOrigin,
      endpointPath: "/stream/org",
      // Byte-match `handleHostedOrgChatModel`: caller fields first, then the
      // sibling fields (providerKey, serverIds) that own the hosted contract.
      extraBodyFields: {
        ...(args.extraBodyFields ?? {}),
        providerKey,
        ...(args.serverIds?.length ? { serverIds: args.serverIds } : {}),
        ...(orgSelection ? { modelSelection: orgSelection, modelSelectionOrigin: args.modelSelectionOrigin } : {}),
        // `/stream/org` maps the effort per org provider (and refuses one it
        // cannot map), reading the selection's; a per-run effort the selection
        // does not carry rides as the top-level field, which wins over it.
        ...(args.settings?.reasoningEffort &&
        orgSelection?.settings?.reasoningEffort !== args.settings.reasoningEffort
          ? { reasoningEffort: args.settings.reasoningEffort }
          : {}),
      },
      ...(args.harness ? { harness: args.harness } : {}),
      ...(args.harness && orgSelection ? { modelSelection: orgSelection } : {}),
    },
    modelSource: "byok",
    finalizeUsage: HOSTED_NOOP_FINALIZE,
    classifyFailure: classifyTurnFailure,
  };
}
