/**
 * Inspector-side adapter of the model selection contract for the eval runner.
 *
 * The backend resolver owns hosted and org-cloud routing: a hosted selection
 * is admitted by the backend's own `/stream` admission and an org selection by
 * `/stream/org` — the calls the runner already makes, so this adapter adds no
 * round trip. What it decides locally is everything the runner can decide
 * WITHOUT the backend, using the contract's refusal codes:
 *
 *  - which rail a saved selection runs on. An explicit `org` / `local`
 *    selection NEVER matches the hosted catalog first — that hosted-first
 *    read is what let a saved "use my own key" choice run on MCPJam's key.
 *    Only a legacy bare id keeps today's hosted-first behaviour;
 *  - `credential_missing` when the connection a selection names cannot be
 *    reached from this run (no organization to resolve an org connection in,
 *    the org config no longer lists the provider, no local key for the
 *    provider) — refused before any request is built, never "fixed" by
 *    running on another credential;
 *  - `invalid_model` when a connection with a known model list does not serve
 *    the model;
 *  - the `fallback_prohibited` refusal shape for executors that walk a
 *    fallback.
 *
 * TODO(P0-1): `harness_unsupported` / `harness_unknown` from the harness ×
 * model support evidence (`harnessModelSupport`, inspector PR #5559). That
 * module is not on this branch's base; wire it here once it lands instead of
 * duplicating the evidence table.
 *
 * No secrets in, none out: the input carries key PRESENCE (a key map is only
 * probed with `has`), and a refusal's `evidence` names providers and
 * connections, never a key.
 */
import {
  assertModelSelection,
  isLegacySelection,
  selectionFromLegacyModelId,
  validateModelSelection,
  type ModelConnectionRef,
  type ModelSelection,
  type ModelSelectionPurpose,
  type RequestedModelSelection,
} from "@mcpjam/sdk";

/** Refusal codes of the model selection contract. */
export type ModelRefusalCode =
  | "invalid_model"
  | "model_retired"
  | "harness_unsupported"
  | "harness_unknown"
  | "capability_missing"
  | "capability_unknown"
  | "policy_no_zdr_endpoint"
  | "credential_missing"
  | "free_tier_model_restricted"
  | "guest_model_not_allowed"
  | "fallback_prohibited";

export type ModelRefusal = {
  code: ModelRefusalCode;
  reason: string;
  evidence?: Record<string, unknown>;
};

/** Thrown by the runner when a selection is refused before execution. */
export class ModelResolutionRefusalError extends Error {
  readonly code: ModelRefusalCode;
  readonly refusals: ModelRefusal[];

  constructor(refusals: ModelRefusal[]) {
    const first = refusals[0];
    super(
      refusals
        .map((refusal) => `${refusal.code}: ${refusal.reason}`)
        .join("; "),
    );
    this.name = "ModelResolutionRefusalError";
    this.code = first?.code ?? "invalid_model";
    this.refusals = refusals;
  }
}

/** Rail the runner executes a resolved selection on. */
export type LocalResolutionRail =
  /** MCPJam-hosted: backend `/stream` (its admission decides the rest). */
  | "hosted"
  /** Org connection: backend `/stream/org` (or the org's local runtime). */
  | "org"
  /** A key on this machine / in this request. */
  | "local";

export type LocalResolutionPlan = {
  rail: LocalResolutionRail;
  /** The id the provider is called with (`nativeModelId`, else `modelId`). */
  wireModelId: string;
  /** Org provider key (`openai`, `custom:<slug>`, …) or the local provider. */
  providerKey?: string;
  connectionRef?: ModelConnectionRef;
  fallback: ModelSelection["fallback"];
};

export type LocalResolutionResult =
  | { ok: true; plan: LocalResolutionPlan }
  | { ok: false; refusals: ModelRefusal[] };

/** Provider keys that run without an API key. */
const KEYLESS_LOCAL_PROVIDERS = new Set(["ollama"]);

export type ResolveLocalModelSelectionInput = {
  selection: ModelSelection;
  purpose: ModelSelectionPurpose;
  /**
   * The org provider key the legacy fields of the same record derive
   * (`deriveOrgProviderKey`), used to find the org connection in a resolved
   * org config. The org config does not carry provider row ids, so the
   * connection's id itself is checked by the backend: the runner forwards
   * the selection ({@link backendModelSelection}) as `modelSelection` on
   * `/stream/org` and `/stream/org/resolve`, and a backend that understands
   * it re-resolves the `connectionRef` before decrypting any key (a deleted
   * or re-created connection is `credential_missing`). A backend that
   * predates selections ignores the field, and the request runs as the
   * legacy `providerKey` + `model` pair it always was.
   */
  orgProviderKey?: string;
  /** Whether the run has an organization/project to resolve org connections in. */
  hasOrgTarget: boolean;
  /**
   * The run's resolved org config, when the route resolved one: providers by
   * key, with their known model lists. `undefined` = not resolved here (the
   * backend decides on `/stream/org`).
   */
  orgProviders?: ReadonlyArray<{
    providerKey: string;
    modelIds?: readonly string[];
  }>;
  /** Presence check for a local provider key. Never returns the key. */
  hasLocalKey: (providerKey: string) => boolean;
};

/** Provider-native id a selection is executed with. */
export function wireModelIdForSelection(selection: ModelSelection): string {
  return selection.nativeModelId ?? selection.modelId;
}

/** The model segment of a custom id, for matching a provider's model list. */
function modelNameForProvider(
  wireModelId: string,
  providerKey: string,
): string {
  const prefix = `${providerKey}:`;
  return wireModelId.startsWith(prefix)
    ? wireModelId.slice(prefix.length)
    : wireModelId;
}

/**
 * Resolve a saved selection to a rail, or refuse it with the contract's
 * codes. Pure.
 */
export function resolveLocalModelSelection(
  input: ResolveLocalModelSelectionInput,
): LocalResolutionResult {
  const { selection } = input;
  const wireModelId = wireModelIdForSelection(selection);
  const fallback = selection.fallback;

  if (selection.source === "hosted") {
    return { ok: true, plan: { rail: "hosted", wireModelId, fallback } };
  }

  const connectionRef = selection.connectionRef;
  if (selection.source === "org") {
    if (connectionRef?.kind !== "orgProvider") {
      return refuse(
        "credential_missing",
        "org selection has no org connection",
      );
    }
    const evidence = { connectionId: connectionRef.id };
    if (!input.hasOrgTarget) {
      return refuse(
        "credential_missing",
        "this run has no organization to resolve the saved org connection in",
        evidence,
      );
    }
    if (!input.orgProviderKey) {
      return refuse(
        "credential_missing",
        "the saved org connection names no provider this model can use",
        evidence,
      );
    }
    if (input.orgProviders) {
      const provider = input.orgProviders.find(
        (row) => row.providerKey === input.orgProviderKey,
      );
      if (!provider) {
        return refuse(
          "credential_missing",
          `the saved org connection (${input.orgProviderKey}) is no longer configured for this organization`,
          { ...evidence, providerKey: input.orgProviderKey },
        );
      }
      if (
        provider.modelIds?.length &&
        (input.orgProviderKey.startsWith("custom:") ||
          input.orgProviderKey === "ollama") &&
        !provider.modelIds.includes(
          modelNameForProvider(wireModelId, input.orgProviderKey),
        )
      ) {
        return refuse(
          "invalid_model",
          `${input.orgProviderKey} does not serve ${selection.modelId}`,
          { ...evidence, providerKey: input.orgProviderKey },
        );
      }
    }
    return {
      ok: true,
      plan: {
        rail: "org",
        wireModelId,
        providerKey: input.orgProviderKey,
        connectionRef,
        fallback,
      },
    };
  }

  // source === "local"
  if (connectionRef?.kind !== "localProvider") {
    return refuse(
      "credential_missing",
      "local selection has no local provider",
    );
  }
  const providerKey = connectionRef.providerKey;
  if (providerKey === "custom") {
    return refuse(
      "credential_missing",
      `local custom provider "${connectionRef.customProviderName ?? ""}" is not available to this runner`,
      { providerKey, customProviderName: connectionRef.customProviderName },
    );
  }
  if (
    !KEYLESS_LOCAL_PROVIDERS.has(providerKey) &&
    !input.hasLocalKey(providerKey)
  ) {
    return refuse(
      "credential_missing",
      `no ${providerKey} key is configured for this run`,
      { providerKey },
    );
  }
  return {
    ok: true,
    plan: { rail: "local", wireModelId, providerKey, connectionRef, fallback },
  };
}

/**
 * The refusal an executor records instead of taking a fallback the selection
 * does not permit. `null` when the fallback is permitted.
 */
export function fallbackProhibitedRefusal(
  selection: RequestedModelSelection,
  attempted: { rail: string; fallbackRail: string },
): ModelRefusal | null {
  if (isLegacySelection(selection)) return null;
  if (selection.fallback.provider !== "none") return null;
  return {
    code: "fallback_prohibited",
    reason: `the ${attempted.rail} attempt failed and this selection does not permit a ${attempted.fallbackRail} fallback`,
    evidence: { rail: attempted.rail, fallbackRail: attempted.fallbackRail },
  };
}

/**
 * The selection the runner forwards to the backend as the request body's
 * `modelSelection`: a `hosted` one to `/stream`, an `org` one to `/stream/org`
 * and `/stream/org/resolve`, so the backend resolver re-checks it (and records
 * it as the requested selection instead of `legacy`). A `local` selection is
 * never sent: it runs on this request's own key and names nothing the backend
 * could resolve. `undefined` for none.
 *
 * Validated (and normalized) with the SDK validator first, which rejects any
 * field outside the selection shape, so nothing but the saved choice (never a
 * key) can ride along. An invalid selection throws rather than being dropped:
 * dropping it would send the request as legacy and skip the backend's
 * connection re-check.
 */
export function backendModelSelection(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (selection === undefined) return undefined;
  const validated = assertModelSelection(selection, "modelSelection");
  return validated.source === "local" ? undefined : validated;
}

/**
 * Read a stored selection off an untrusted record. Invalid → `undefined` (the
 * record reads as legacy); valid → the normalized selection.
 */
export function readStoredModelSelection(
  value: unknown,
): ModelSelection | undefined {
  if (value === undefined || value === null) return undefined;
  const result = validateModelSelection(value);
  return result.ok ? result.selection : undefined;
}

/** The requested selection for a record: its selection, else legacy. */
export function requestedModelSelection(args: {
  selection?: ModelSelection;
  legacyModelId: string;
}): RequestedModelSelection {
  return args.selection ?? selectionFromLegacyModelId(args.legacyModelId);
}

function refuse(
  code: ModelRefusalCode,
  reason: string,
  evidence?: Record<string, unknown>,
): LocalResolutionResult {
  return {
    ok: false,
    refusals: [{ code, reason, ...(evidence ? { evidence } : {}) }],
  };
}
