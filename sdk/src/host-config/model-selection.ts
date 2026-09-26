/**
 * Saved model selection — which model, on whose credentials, through which
 * connection, with which settings, and what the executor may do on failure.
 *
 * SOURCE OF TRUTH for the shape. The MCPJam backend hand-mirrors these types
 * (keep field names and unions identical; the backend pins the mirror). A
 * bare model id string is not enough to reproduce a run: it drops whose key
 * served the call and which of two same-provider connections was meant, so a
 * saved "use my own key" choice could silently run on MCPJam's key.
 *
 * Invariants enforced by {@link validateModelSelection}:
 *
 *  - **No secrets, ever.** A selection carries a `connectionRef`, never a key,
 *    a sealed secret handle or a vault id. Unknown keys are rejected at every
 *    level, so a secret-bearing field (`apiKey`, `headers`, …) can never be
 *    stored alongside one.
 *  - `source: "hosted"` has no `connectionRef`; `"org"` requires
 *    `connectionRef.kind === "orgProvider"`; `"local"` requires
 *    `connectionRef.kind === "localProvider"`.
 *  - `modelId` is the canonical `provider/model` id (canonical spellings such
 *    as `z-ai/`, `x-ai/`, `meta-llama/`; gateway spellings exist only on the
 *    wire). Where a record also stores a bare `modelId` beside a selection
 *    (`HostConfigInputV2.modelId`), the two must agree — disagreement is a
 *    validation error, not a precedence rule.
 *  - `settings.temperature` is finite and within [0, 2].
 *  - `fallback.model` is always `"none"`: no surface substitutes a different
 *    model.
 *
 * Pure + browser-safe: no Node-only APIs, no external imports.
 */

// ── Types ────────────────────────────────────────────────────────────────

/** Whose credentials pay for and serve the call. */
export const MODEL_SELECTION_SOURCES = ["hosted", "org", "local"] as const;
export type ModelSelectionSource = (typeof MODEL_SELECTION_SOURCES)[number];

/**
 * Which connection serves a non-hosted selection. A provider NAME is not
 * enough: two Azure deployments or two org connections must stay
 * distinguishable.
 *
 * - `orgProvider` — an organization model provider row, by id.
 * - `localProvider` — a provider configured on the user's own machine, by
 *   provider key (plus the custom provider's name for custom providers).
 */
export type ModelConnectionRef =
  | { kind: "orgProvider"; id: string }
  | {
      kind: "localProvider";
      providerKey: string;
      customProviderName?: string;
    };

export const MODEL_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

/** Per-selection sampling / reasoning settings. */
export type ModelSelectionSettings = {
  reasoningEffort?: ModelReasoningEffort;
  /** Finite, within [0, 2]. */
  temperature?: number;
};

export const MODEL_SELECTION_FALLBACK_PROVIDERS = [
  "none",
  "openrouter",
] as const;
export type ModelSelectionFallbackProvider =
  (typeof MODEL_SELECTION_FALLBACK_PROVIDERS)[number];

/**
 * What the executor may do when the resolved rail fails. With
 * `provider: "none"` a fallback that would have been taken is a refusal, not
 * a silent deviation. `model` is always `"none"`; the field exists so a later
 * policy can be expressed without a schema change.
 */
export type ModelSelectionFallback = {
  provider: ModelSelectionFallbackProvider;
  model: "none";
};

/** A saved model choice. Never carries a secret. */
export type ModelSelection = {
  /** Canonical `provider/model` id. */
  modelId: string;
  source: ModelSelectionSource;
  /** Required for `org` / `local`, absent for `hosted`. */
  connectionRef?: ModelConnectionRef;
  /** Deployment / native id where it is not derivable from the canonical id
   *  (Azure deployment name, Bedrock inference profile, custom provider). */
  nativeModelId?: string;
  settings?: ModelSelectionSettings;
  fallback: ModelSelectionFallback;
};

/**
 * What a bare stored model id becomes when read. Exists only in memory and in
 * an execution record's `requested` — it is never written back as a saved
 * selection.
 */
export type LegacyModelSelection = { source: "legacy"; modelId: string };

/** What every consumer of a saved choice accepts. */
export type RequestedModelSelection = ModelSelection | LegacyModelSelection;

/** Why a model is being resolved. Decides the default fallback. */
export const MODEL_SELECTION_PURPOSES = [
  "chat",
  "evalTarget",
  "persona",
  "judge",
  "analysis",
  "harnessLease",
] as const;
export type ModelSelectionPurpose = (typeof MODEL_SELECTION_PURPOSES)[number];

// ── Validation ───────────────────────────────────────────────────────────

export type ModelSelectionIssueCode =
  /** A required field is missing. */
  | "required"
  /** Wrong JSON type (e.g. not a plain object, not a string). */
  | "invalid_type"
  /** Right type, value outside the allowed set. */
  | "invalid_value"
  /** A key the shape does not define (the no-secrets guard). */
  | "unknown_key"
  /** `connectionRef` presence/kind does not match `source`. */
  | "connection_ref_mismatch"
  /** `modelId` is not a canonical `provider/model` id. */
  | "model_id_not_canonical"
  /** A number outside its allowed range. */
  | "out_of_range";

export type ModelSelectionIssue = {
  /** Dotted path from the selection root, e.g. `settings.temperature`. `""`
   *  is the selection itself. */
  path: string;
  code: ModelSelectionIssueCode;
  message: string;
};

export type ModelSelectionValidation =
  | { ok: true; selection: ModelSelection }
  | { ok: false; issues: ModelSelectionIssue[] };

/**
 * Thrown by {@link assertModelSelection} (and so by the host-config
 * canonicalizer). The message follows the host-config style
 * (`hostConfigV2: modelSelection.<path> …`); `issues` carries the structured
 * form.
 */
export class ModelSelectionValidationError extends Error {
  readonly issues: ModelSelectionIssue[];

  constructor(label: string, issues: ModelSelectionIssue[]) {
    super(
      issues
        .map((issue) =>
          issue.path === ""
            ? `${label}: ${issue.message}`
            : `${label}.${issue.path}: ${issue.message}`
        )
        .join("; ")
    );
    this.name = "ModelSelectionValidationError";
    this.issues = issues;
  }
}

const SELECTION_KEYS: ReadonlySet<string> = new Set([
  "modelId",
  "source",
  "connectionRef",
  "nativeModelId",
  "settings",
  "fallback",
]);
const ORG_REF_KEYS: ReadonlySet<string> = new Set(["kind", "id"]);
const LOCAL_REF_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "providerKey",
  "customProviderName",
]);
const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "temperature",
]);
const FALLBACK_KEYS: ReadonlySet<string> = new Set(["provider", "model"]);

const SOURCE_SET: ReadonlySet<string> = new Set(MODEL_SELECTION_SOURCES);
const EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS);
const FALLBACK_PROVIDER_SET: ReadonlySet<string> = new Set(
  MODEL_SELECTION_FALLBACK_PROVIDERS
);

/**
 * Canonical-looking model id: a lowercase provider segment, `/`, and a
 * non-empty model segment, no whitespace anywhere. Deliberately a SHAPE check
 * — catalog membership is the resolver's job, not the saved shape's.
 */
const CANONICAL_MODEL_ID = /^[a-z0-9][a-z0-9._:-]*\/[^\s/]\S*$/;

export const MODEL_SELECTION_TEMPERATURE_MIN = 0;
export const MODEL_SELECTION_TEMPERATURE_MAX = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function join(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ModelSelectionIssue[]
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      issues.push({
        path: join(path, key),
        code: "unknown_key",
        message: `unknown key "${key}" (a selection never carries credentials)`,
      });
    }
  }
}

/** Non-empty string with no surrounding whitespace, or an issue. */
function readIdentifier(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ModelSelectionIssue[],
  required: boolean
): string | undefined {
  const at = join(path, key);
  if (!has(obj, key) || obj[key] === undefined) {
    if (required) {
      issues.push({ path: at, code: "required", message: "is required" });
    }
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== "string") {
    issues.push({
      path: at,
      code: "invalid_type",
      message: "must be a string",
    });
    return undefined;
  }
  if (value.trim() === "" || value.trim() !== value) {
    issues.push({
      path: at,
      code: "invalid_value",
      message: "must be a non-empty string without surrounding whitespace",
    });
    return undefined;
  }
  return value;
}

function readConnectionRef(
  raw: unknown,
  issues: ModelSelectionIssue[]
): ModelConnectionRef | undefined {
  const path = "connectionRef";
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "invalid_type",
      message: "must be a plain object",
    });
    return undefined;
  }
  if (raw.kind === "orgProvider") {
    rejectUnknownKeys(raw, ORG_REF_KEYS, path, issues);
    const id = readIdentifier(raw, "id", path, issues, true);
    return id === undefined ? undefined : { kind: "orgProvider", id };
  }
  if (raw.kind === "localProvider") {
    rejectUnknownKeys(raw, LOCAL_REF_KEYS, path, issues);
    const providerKey = readIdentifier(raw, "providerKey", path, issues, true);
    const customProviderName = readIdentifier(
      raw,
      "customProviderName",
      path,
      issues,
      false
    );
    if (providerKey === undefined) return undefined;
    return {
      kind: "localProvider",
      providerKey,
      ...(customProviderName !== undefined ? { customProviderName } : {}),
    };
  }
  issues.push({
    path: join(path, "kind"),
    code: raw.kind === undefined ? "required" : "invalid_value",
    message: 'must be "orgProvider" or "localProvider"',
  });
  return undefined;
}

function readSettings(
  raw: unknown,
  issues: ModelSelectionIssue[]
): ModelSelectionSettings | undefined {
  const path = "settings";
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "invalid_type",
      message: "must be a plain object",
    });
    return undefined;
  }
  rejectUnknownKeys(raw, SETTINGS_KEYS, path, issues);
  const out: ModelSelectionSettings = {};
  if (raw.reasoningEffort !== undefined) {
    if (
      typeof raw.reasoningEffort === "string" &&
      EFFORT_SET.has(raw.reasoningEffort)
    ) {
      out.reasoningEffort = raw.reasoningEffort as ModelReasoningEffort;
    } else {
      issues.push({
        path: join(path, "reasoningEffort"),
        code: "invalid_value",
        message: `must be one of ${MODEL_REASONING_EFFORTS.map(
          (e) => `"${e}"`
        ).join(", ")}`,
      });
    }
  }
  if (raw.temperature !== undefined) {
    const t = raw.temperature;
    if (typeof t !== "number" || !Number.isFinite(t)) {
      issues.push({
        path: join(path, "temperature"),
        code: "invalid_type",
        message: "must be a finite number",
      });
    } else if (
      t < MODEL_SELECTION_TEMPERATURE_MIN ||
      t > MODEL_SELECTION_TEMPERATURE_MAX
    ) {
      issues.push({
        path: join(path, "temperature"),
        code: "out_of_range",
        message: `must be within [${MODEL_SELECTION_TEMPERATURE_MIN}, ${MODEL_SELECTION_TEMPERATURE_MAX}]`,
      });
    } else {
      out.temperature = t;
    }
  }
  return out;
}

function readFallback(
  raw: unknown,
  issues: ModelSelectionIssue[]
): ModelSelectionFallback | undefined {
  const path = "fallback";
  if (raw === undefined) {
    issues.push({ path, code: "required", message: "is required" });
    return undefined;
  }
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      code: "invalid_type",
      message: "must be a plain object",
    });
    return undefined;
  }
  rejectUnknownKeys(raw, FALLBACK_KEYS, path, issues);
  let ok = true;
  if (
    typeof raw.provider !== "string" ||
    !FALLBACK_PROVIDER_SET.has(raw.provider)
  ) {
    ok = false;
    issues.push({
      path: join(path, "provider"),
      code: raw.provider === undefined ? "required" : "invalid_value",
      message: 'must be "none" or "openrouter"',
    });
  }
  if (raw.model !== "none") {
    ok = false;
    issues.push({
      path: join(path, "model"),
      code: raw.model === undefined ? "required" : "invalid_value",
      message: 'must be "none" (no surface substitutes a different model)',
    });
  }
  if (!ok) return undefined;
  return {
    provider: raw.provider as ModelSelectionFallbackProvider,
    model: "none",
  };
}

/**
 * Validate an untrusted value as a saved {@link ModelSelection}. On success
 * returns a fresh copy with a fixed key order (modelId, source,
 * connectionRef, nativeModelId, settings, fallback) so equal selections
 * serialize byte-identically; an empty `settings` object collapses to absent.
 * On failure returns every issue found, not just the first.
 *
 * A `LegacyModelSelection` (`source: "legacy"`) is NOT a valid saved
 * selection — it is never written back.
 */
export function validateModelSelection(
  value: unknown
): ModelSelectionValidation {
  const issues: ModelSelectionIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      ok: false,
      issues: [
        { path: "", code: "invalid_type", message: "must be a plain object" },
      ],
    };
  }
  rejectUnknownKeys(value, SELECTION_KEYS, "", issues);

  const modelId = readIdentifier(value, "modelId", "", issues, true);
  if (modelId !== undefined && !CANONICAL_MODEL_ID.test(modelId)) {
    issues.push({
      path: "modelId",
      code: "model_id_not_canonical",
      message: `"${modelId}" is not a canonical "provider/model" id`,
    });
  }

  let source: ModelSelectionSource | undefined;
  if (value.source === undefined) {
    issues.push({ path: "source", code: "required", message: "is required" });
  } else if (typeof value.source === "string" && SOURCE_SET.has(value.source)) {
    source = value.source as ModelSelectionSource;
  } else {
    issues.push({
      path: "source",
      code: "invalid_value",
      message:
        value.source === "legacy"
          ? '"legacy" is read-only: a legacy selection is never saved'
          : 'must be "hosted", "org" or "local"',
    });
  }

  const connectionRef =
    value.connectionRef === undefined
      ? undefined
      : readConnectionRef(value.connectionRef, issues);
  if (source === "hosted" && value.connectionRef !== undefined) {
    issues.push({
      path: "connectionRef",
      code: "connection_ref_mismatch",
      message: 'must be absent when source is "hosted"',
    });
  } else if (source === "org" || source === "local") {
    const expectedKind = source === "org" ? "orgProvider" : "localProvider";
    if (value.connectionRef === undefined) {
      issues.push({
        path: "connectionRef",
        code: "connection_ref_mismatch",
        message: `is required when source is "${source}" (kind "${expectedKind}")`,
      });
    } else if (
      isPlainObject(value.connectionRef) &&
      (value.connectionRef.kind === "orgProvider" ||
        value.connectionRef.kind === "localProvider") &&
      value.connectionRef.kind !== expectedKind
    ) {
      issues.push({
        path: "connectionRef.kind",
        code: "connection_ref_mismatch",
        message: `must be "${expectedKind}" when source is "${source}"`,
      });
    }
  }

  const nativeModelId = readIdentifier(
    value,
    "nativeModelId",
    "",
    issues,
    false
  );
  const settings =
    value.settings === undefined
      ? undefined
      : readSettings(value.settings, issues);
  const fallback = readFallback(value.fallback, issues);

  if (issues.length > 0) return { ok: false, issues };

  const hasSettings =
    settings !== undefined &&
    (settings.reasoningEffort !== undefined ||
      settings.temperature !== undefined);
  const selection: ModelSelection = {
    modelId: modelId as string,
    source: source as ModelSelectionSource,
    ...(connectionRef !== undefined ? { connectionRef } : {}),
    ...(nativeModelId !== undefined ? { nativeModelId } : {}),
    ...(hasSettings
      ? {
          settings: {
            ...(settings.reasoningEffort !== undefined
              ? { reasoningEffort: settings.reasoningEffort }
              : {}),
            ...(settings.temperature !== undefined
              ? { temperature: settings.temperature }
              : {}),
          },
        }
      : {}),
    fallback: fallback as ModelSelectionFallback,
  };
  return { ok: true, selection };
}

/** `true` when `value` is a valid saved {@link ModelSelection}. */
export function isModelSelection(value: unknown): value is ModelSelection {
  return validateModelSelection(value).ok;
}

/**
 * Validate and return the normalized selection, or throw a
 * {@link ModelSelectionValidationError} whose message is prefixed with
 * `label` (default `"modelSelection"`).
 */
export function assertModelSelection(
  value: unknown,
  label = "modelSelection"
): ModelSelection {
  const result = validateModelSelection(value);
  if (!result.ok) throw new ModelSelectionValidationError(label, result.issues);
  return result.selection;
}

// ── Legacy ids ───────────────────────────────────────────────────────────

/**
 * Wrap a bare stored model id (a record saved before selections existed) as a
 * {@link LegacyModelSelection}.
 *
 * Legacy rule: a bare id keeps today's behavior — hosted catalog first, then
 * the user's own provider — and is recorded as `source: "legacy"` so
 * provenance shows the source was inferred, not chosen. Do NOT backfill a
 * `source` from which keys happen to be configured now: that would silently
 * change an existing billing choice. The result is never written back.
 *
 * The id is taken verbatim (legacy rows may hold bare, non-canonical ids);
 * only an empty or non-string id is rejected.
 *
 * @remarks Legacy input only. New writes save a full {@link ModelSelection};
 * nothing should mint a legacy selection except a read of an old row.
 */
export function selectionFromLegacyModelId(
  modelId: string
): LegacyModelSelection {
  if (typeof modelId !== "string" || modelId.trim() === "") {
    throw new Error("selectionFromLegacyModelId: modelId must be non-empty");
  }
  return { source: "legacy", modelId };
}

/** `true` for the in-memory legacy form (`{ source: "legacy", modelId }`). */
export function isLegacySelection(
  value: unknown
): value is LegacyModelSelection {
  return (
    isPlainObject(value) &&
    value.source === "legacy" &&
    typeof value.modelId === "string" &&
    value.modelId.trim() !== ""
  );
}

// ── Keys and defaults ────────────────────────────────────────────────────

/**
 * Stable row key: `${source}:${connection}:${modelId}` where `connection` is
 * the org provider id, the local `providerKey[:customProviderName]`, or `""`
 * (hosted / legacy). Two rows for the same model id through different
 * connections get different keys, so pickers never collapse them.
 *
 * Every variable part is `encodeURIComponent`-encoded, so a `:` inside an id,
 * a provider key, a custom provider name or a model id (all legal) can never
 * make two different selections produce the same key. Only the separators
 * are raw `:`. (`/` in a model id is encoded too: `anthropic%2Fclaude-…`.)
 */
export function selectionKey(selection: RequestedModelSelection): string {
  const enc = encodeURIComponent;
  let connection = "";
  if (selection.source !== "legacy" && selection.connectionRef) {
    const ref = selection.connectionRef;
    connection =
      ref.kind === "orgProvider"
        ? enc(ref.id)
        : ref.customProviderName !== undefined
          ? `${enc(ref.providerKey)}:${enc(ref.customProviderName)}`
          : enc(ref.providerKey);
  }
  return `${selection.source}:${connection}:${enc(selection.modelId)}`;
}

/**
 * Fallback applied when a saved selection has none for this purpose.
 * Playground `chat` keeps today's OpenRouter fallback (recorded as a
 * deviation when taken); every automated purpose refuses instead.
 */
export function defaultFallbackForPurpose(
  purpose: ModelSelectionPurpose
): ModelSelectionFallback {
  return {
    provider: purpose === "chat" ? "openrouter" : "none",
    model: "none",
  };
}
