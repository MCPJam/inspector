/**
 * The execution record a local-runtime org turn reports on
 * `/stream/org/local-usage`.
 *
 * The inspector ran the provider call itself (an org connection whose runtime
 * is `local`: the backend handed back the key for this request only), so the
 * backend never saw it. The writeback may carry an `execution` record, which
 * the backend checks against its own re-resolution of the request's
 * `modelSelection` (same requested selection, connection, rail `local`, wire
 * model id, and every attempt on that rail and model) and REBUILDS from its
 * own plan, taking only the attempts' outcomes, the effective settings and
 * the upstream model from here. A record that does not parse against the
 * backend's closed validator, or disagrees, is not stored.
 *
 * So this builder is deliberately narrow: it copies known keys only, from the
 * authoritative resolution the inspector already has (the saved selection and
 * the resolve response's provider key), and never a key, header or anything
 * outside the closed shape below. The shape mirrors the backend's
 * `executionRecordValidator` field for field, and is checked at compile time
 * to be a valid SDK `ExecutionRecord` (the reader the inspector and CLI
 * render it with).
 *
 * Only a saved `org` selection produces a record: a legacy request (no
 * selection) has nothing the backend could check it against, and a `local`
 * selection names no org connection.
 */
import {
  PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS,
  type ExecutionRecord,
  type ModelConnectionRef,
  type ModelSelection,
} from "@mcpjam/sdk";
import type { EffectiveModelSettings } from "./model-selection-settings.js";

/** Re-exported: the SDK's reader renders 0 as "provider default". */
export { PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS };

/** How a local provider call ended. `aborted` is reported as an error. */
export type LocalAttemptOutcome =
  { kind: "ok" } | { kind: "error"; code?: string } | { kind: "aborted" };

export type LocalExecutionAttempt = {
  rail: "local";
  wireModelId: string;
  outcome: "ok" | "error";
  code?: string;
  at: number;
};

/** The closed record shape `/stream/org/local-usage` accepts for this rail. */
export type LocalExecutionRecord = {
  requested: ModelSelection;
  resolved: {
    rail: "local";
    wireModelId: string;
    connectionRef?: ModelConnectionRef;
    nativeModelId?: string;
    offering: { rail: "local"; providerKey: string; nativeModelId?: string };
  };
  effectiveSettings: {
    reasoningEffort?: string;
    temperature?: number;
    maxOutputTokens: number;
  };
  attempts: LocalExecutionAttempt[];
  upstreamModel?: string;
};

function copyConnectionRef(ref: ModelConnectionRef): ModelConnectionRef {
  return ref.kind === "orgProvider"
    ? { kind: "orgProvider", id: ref.id }
    : {
        kind: "localProvider",
        providerKey: ref.providerKey,
        ...(ref.customProviderName !== undefined
          ? { customProviderName: ref.customProviderName }
          : {}),
      };
}

/** The saved selection, known keys only (the record's `requested`). */
function copySelection(selection: ModelSelection): ModelSelection {
  const settings = selection.settings;
  const hasSettings =
    settings !== undefined &&
    (settings.reasoningEffort !== undefined ||
      settings.temperature !== undefined);
  return {
    modelId: selection.modelId,
    source: selection.source,
    ...(selection.connectionRef
      ? { connectionRef: copyConnectionRef(selection.connectionRef) }
      : {}),
    ...(selection.nativeModelId !== undefined
      ? { nativeModelId: selection.nativeModelId }
      : {}),
    ...(hasSettings
      ? {
          settings: {
            ...(settings!.reasoningEffort !== undefined
              ? { reasoningEffort: settings!.reasoningEffort }
              : {}),
            ...(settings!.temperature !== undefined
              ? { temperature: settings!.temperature }
              : {}),
          },
        }
      : {}),
    fallback: {
      provider: selection.fallback.provider,
      model: selection.fallback.model,
    },
  };
}

/**
 * Build the record for one local-runtime org turn. `undefined` unless the
 * turn ran under a saved `org` selection.
 */
export function buildLocalExecutionRecord(args: {
  /** The saved selection the turn ran under. */
  selection: ModelSelection | undefined;
  /** The org provider key the resolve response named (`openai`, `custom:x`). */
  providerKey: string;
  /** The id the provider was called with (the request body's `model`). */
  wireModelId: string;
  /** The settings the provider call was actually sent with. */
  effectiveSettings: EffectiveModelSettings & { maxOutputTokens?: number };
  outcome: LocalAttemptOutcome;
  at: number;
  /** The model id the provider reported serving, when it reported one. */
  upstreamModel?: string;
}): LocalExecutionRecord | undefined {
  const { selection } = args;
  if (selection?.source !== "org" || !selection.connectionRef) {
    return undefined;
  }
  const nativeModelId = selection.nativeModelId;
  const attempt: LocalExecutionAttempt =
    args.outcome.kind === "ok"
      ? {
          rail: "local",
          wireModelId: args.wireModelId,
          outcome: "ok",
          at: args.at,
        }
      : {
          rail: "local",
          wireModelId: args.wireModelId,
          outcome: "error",
          // The backend's own convention for a disconnect: an error attempt
          // coded `aborted` (the closed validator has no third outcome).
          ...(args.outcome.kind === "aborted"
            ? { code: "aborted" }
            : args.outcome.code
              ? { code: args.outcome.code }
              : {}),
          at: args.at,
        };
  const { temperature, reasoningEffort, maxOutputTokens } =
    args.effectiveSettings;
  const upstreamModel = args.upstreamModel?.trim();
  return {
    requested: copySelection(selection),
    resolved: {
      rail: "local",
      wireModelId: args.wireModelId,
      connectionRef: copyConnectionRef(selection.connectionRef),
      ...(nativeModelId !== undefined ? { nativeModelId } : {}),
      offering: {
        rail: "local",
        providerKey: args.providerKey,
        ...(nativeModelId !== undefined ? { nativeModelId } : {}),
      },
    },
    effectiveSettings: {
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      maxOutputTokens:
        typeof maxOutputTokens === "number" &&
        Number.isFinite(maxOutputTokens) &&
        maxOutputTokens > 0
          ? Math.floor(maxOutputTokens)
          : PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS,
    },
    attempts: [attempt],
    ...(upstreamModel ? { upstreamModel } : {}),
  };
}

// Compile-time proof the writer's shape is one the SDK reader accepts.
const _localRecordIsExecutionRecord = (
  record: LocalExecutionRecord,
): ExecutionRecord => record;
void _localRecordIsExecutionRecord;
