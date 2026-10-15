/**
 * Words and shapes for the "Use your keys for all AI features" setting and
 * the organization's default AI model.
 *
 * Pure: no React, no network. Kept apart from the cards so the copy rules
 * live in one place and are testable:
 * - never imply text insights need embeddings;
 * - configuration problems read as "Unavailable", never as a spinner;
 * - no row says it is blocked by itself;
 * - a feature that can't run on organization providers yet says so and
 *   names the one way to run it now: an admin turning the setting off;
 * - harness runtimes run on the organization's own key for their vendor
 *   (Claude Code on Anthropic, Codex on OpenAI), so their row names that
 *   vendor and what doesn't count;
 * - a feature waiting on the organization's default model says so, and the
 *   fix is choosing that model, not adding a provider.
 */
import {
  validateModelSelection,
  type ModelSelection,
} from "@mcpjam/sdk/browser";
import type {
  AiFeatureGroupId,
  AiFeatureGroupReadiness,
  AiOperationId,
  AiOperationReadiness,
  AiReadinessStatus,
  OrgAiModelCheck,
  OrgAiModelKind,
} from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  canonicalPrefix,
  canonicalSelectionModelId,
} from "@/components/chat-v2/shared/model-selection";
import type { ModelDefinition } from "@/shared/types";

// ---------------------------------------------------------------------------
// Feature coverage
// ---------------------------------------------------------------------------

/** Display order and names for the feature groups the backend reports. */
export const AI_FEATURE_GROUPS: ReadonlyArray<{
  id: AiFeatureGroupId;
  label: string;
}> = [
  { id: "chat", label: "Chat" },
  { id: "evals", label: "Evals and grading" },
  { id: "swarms", label: "Swarms and User Testing" },
  { id: "insights", label: "Insights and findings" },
  { id: "generation", label: "Generation" },
  { id: "session_map", label: "Session map" },
  { id: "harness", label: "Harness runtimes" },
  { id: "transcription", label: "Transcription" },
  { id: "ask_mcpjam", label: "Ask MCPJam" },
];

const FEATURE_LABELS = new Map(AI_FEATURE_GROUPS.map((f) => [f.id, f.label]));

export function featureLabel(feature: AiFeatureGroupReadiness): string {
  return FEATURE_LABELS.get(feature.id) ?? feature.label ?? feature.id;
}

/**
 * The backend's feature list in display order. A group this client does not
 * know yet is kept (after the known ones) rather than dropped.
 */
export function orderedFeatures(
  features: readonly AiFeatureGroupReadiness[],
): AiFeatureGroupReadiness[] {
  const rank = new Map(AI_FEATURE_GROUPS.map((f, index) => [f.id, index]));
  return [...features].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export type StatusTone = "success" | "warning" | "destructive" | "muted";

export const AI_STATUS_PRESENTATION: Record<
  AiReadinessStatus,
  { label: string; tone: StatusTone }
> = {
  ready: { label: "Ready", tone: "success" },
  unconfigured: { label: "Unavailable", tone: "warning" },
  unsupported: { label: "Not supported yet", tone: "muted" },
  invalid_credentials: { label: "Invalid credentials", tone: "destructive" },
  temporarily_unavailable: {
    label: "Temporarily unavailable",
    tone: "warning",
  },
  hosted: { label: "MCPJam-provided", tone: "muted" },
};

export function statusPresentation(status: AiReadinessStatus): {
  label: string;
  tone: StatusTone;
} {
  return AI_STATUS_PRESENTATION[status] ?? { label: status, tone: "muted" };
}

/**
 * Badge classes per tone. Tints with the READING foreground (DESIGN.md: small
 * text never sits on a solid status fill), except destructive, whose tint
 * takes `text-destructive`.
 */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  success: "border-success/40 bg-success/10 text-foreground",
  warning: "border-warning/40 bg-warning/10 text-foreground",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "border-border text-muted-foreground",
};

/**
 * What a feature that waits for a later release says. No provider fixes it;
 * turning the setting off runs it on MCPJam-provided models again.
 */
export const NOT_SUPPORTED_YET_GUIDANCE =
  "This feature can't run on organization providers yet. An organization admin can turn this setting off to run it on MCPJam-provided models.";

/**
 * Which organization provider each harness runtime runs on while the setting
 * is on: its own vendor's, on the organization's key.
 */
export const HARNESS_ORG_KEYS_GUIDANCE =
  "Claude Code runs on an Anthropic provider and Codex on an OpenAI provider.";

/** What a harness runtime can't run on while the setting is on. */
export const HARNESS_NOT_SUPPORTED_GUIDANCE =
  "Custom base URLs, local runtimes and models the MCPJam SDK calls directly aren't supported.";

/**
 * The harness row's guidance, or null to fall back to the general one. With
 * no matching provider the fix names the vendor each harness needs, so no one
 * is sent to add a provider the harness would still refuse.
 */
function harnessGuidance(
  status: AiReadinessStatus,
  canManage: boolean,
): string | null {
  switch (status) {
    case "ready":
      return HARNESS_ORG_KEYS_GUIDANCE;
    case "unconfigured":
    case "unsupported": {
      const fix = canManage
        ? "Add a direct Anthropic provider for Claude Code or an OpenAI provider for Codex below."
        : "Ask an organization admin to add a direct Anthropic provider for Claude Code or an OpenAI provider for Codex.";
      return `${fix} ${HARNESS_NOT_SUPPORTED_GUIDANCE}`;
    }
    default:
      return null;
  }
}

/**
 * Under the policy a suite is graded only by a judge someone chose from an
 * organization provider; there is no default judge, so the evals row asks
 * for that choice even when everything else is ready.
 */
export const EVALS_JUDGE_GUIDANCE =
  "Choose a judge model from an organization provider for each suite. A suite without one can't run.";

/**
 * The organization AI model an operation waits on, when choosing (or
 * re-choosing) that model is the fix: the operation runs on an organization
 * model nobody picks, and it is unconfigured.
 *
 * Read from the backend's readiness, never from a list of features. The
 * operation names its model (`modelKind`); an older backend that does not
 * name it still reports `org_model_unconfigured`, which means "no model set"
 * whenever an eligible provider exists (with none, the fix is a provider).
 * `unset` is a model nobody chose; `unusable` is a saved one that can't run
 * (its connection was removed, or it can't do the work).
 */
export function operationModelFix(
  operation: AiOperationReadiness | undefined,
  eligibleConnectionIds?: readonly string[],
): { kind: OrgAiModelKind; reason: "unset" | "unusable" } | null {
  if (!operation || operation.status !== "unconfigured") return null;
  const unset = operation.code === "org_model_unconfigured";
  if (operation.modelKind) {
    return { kind: operation.modelKind, reason: unset ? "unset" : "unusable" };
  }
  if (unset && (eligibleConnectionIds?.length ?? 0) > 0) {
    return {
      kind: modelKindForOperation(operation.operation),
      reason: "unset",
    };
  }
  return null;
}

/** The model an operation runs on when the backend does not name it. */
function modelKindForOperation(operation: AiOperationId): OrgAiModelKind {
  if (operation === "embedding") return "embedding";
  if (operation === "speech_transcription") return "transcription";
  return "default";
}

/** The first model fix among a feature's blockers, if any. */
function featureModelFix(
  feature: AiFeatureGroupReadiness,
  operations: readonly AiOperationReadiness[] | undefined,
  eligibleConnectionIds: readonly string[] | undefined,
): ReturnType<typeof operationModelFix> {
  if (!operations?.length) return null;
  const byId = new Map(operations.map((op) => [op.operation, op]));
  for (const blocker of feature.blockedBy ?? []) {
    const fix = operationModelFix(byId.get(blocker), eligibleConnectionIds);
    if (fix) return fix;
  }
  return null;
}

/**
 * What to do about a feature, in the reader's terms: the actual fix, or
 * nothing when there is none to make. Admins are told what to change below;
 * members are pointed at an admin.
 */
export function featureGuidance(
  feature: AiFeatureGroupReadiness,
  context: {
    /** The backend's eligible connections; absent on an older backend. */
    eligibleConnectionIds?: readonly string[];
    /** The backend's per-operation readiness, to tell a missing model apart. */
    operations?: readonly AiOperationReadiness[];
    canManage: boolean;
  },
): string | null {
  const { canManage } = context;
  if (feature.id === "harness") {
    const guidance = harnessGuidance(feature.status, canManage);
    if (guidance !== null) return guidance;
  }
  switch (feature.status) {
    case "ready":
      return feature.id === "evals" ? EVALS_JUDGE_GUIDANCE : null;
    case "unsupported":
      return NOT_SUPPORTED_YET_GUIDANCE;
    case "unconfigured": {
      const noEligibleProvider =
        (context.eligibleConnectionIds?.length ?? 0) === 0;
      const modelFix = featureModelFix(
        feature,
        context.operations,
        context.eligibleConnectionIds,
      );
      if (modelFix && !noEligibleProvider) {
        return orgAiModelGuidance(modelFix, canManage);
      }
      const fix = noEligibleProvider
        ? canManage
          ? "Add a direct cloud provider below."
          : "Ask an organization admin to add a direct cloud provider."
        : canManage
          ? "None of the organization's providers can serve this feature. Add a direct cloud provider that can."
          : "None of the organization's providers can serve this feature. Ask an organization admin to add one that can.";
      if (modelFix) {
        return `${fix} Then choose the organization's ${orgAiModelNoun(modelFix.kind)}.`;
      }
      return feature.id === "evals"
        ? `${fix} Then choose a judge model from it for each suite.`
        : fix;
    }
    case "invalid_credentials":
      return canManage
        ? "The provider rejected its stored credentials. Update the key below."
        : "The provider rejected its stored credentials. Ask an organization admin to update the key.";
    case "temporarily_unavailable":
      return "The provider is rate-limited or failing. Try again shortly.";
    default:
      return null;
  }
}

/** The operation a feature group is named after. */
const FEATURE_OWN_OPERATION: Partial<Record<AiFeatureGroupId, AiOperationId>> =
  {
    chat: "chat",
    harness: "harness_runtime",
    transcription: "speech_transcription",
    ask_mcpjam: "agent_chat",
  };

/**
 * The operations a feature's "Blocked by" line names.
 *
 * Never the feature itself ("Ask MCPJam" blocked by Ask MCPJam): the status
 * and its guidance already say that. Nothing for a ready feature, and
 * nothing for one that is not supported yet: there the line would read as
 * something to fix, and there is nothing to fix.
 */
export function listedBlockers(
  feature: AiFeatureGroupReadiness,
): AiOperationId[] {
  if (
    feature.status === "ready" ||
    feature.status === "hosted" ||
    feature.status === "unsupported"
  ) {
    return [];
  }
  const own = FEATURE_OWN_OPERATION[feature.id];
  return (feature.blockedBy ?? []).filter((operation) => operation !== own);
}

const OPERATION_LABELS: Record<AiOperationId, string> = {
  chat: "chat",
  eval_target: "the eval target model",
  persona_driver: "simulated users",
  harness_runtime: "a harness runtime",
  judge: "grading",
  text_analysis: "text analysis",
  text_generation: "text generation",
  typed_decision: "typed decisions",
  embedding: "embeddings",
  speech_transcription: "speech transcription",
  agent_chat: "Ask MCPJam",
};

export function operationLabel(operation: AiOperationId): string {
  return OPERATION_LABELS[operation] ?? operation.replace(/_/g, " ");
}

/** "a", "a and b", "a, b and c". */
function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The "Blocked by" line for {@link listedBlockers}, or null when empty. */
export function blockedBySentence(
  operations: readonly AiOperationId[],
): string | null {
  if (operations.length === 0) return null;
  return `Blocked by ${joinWithAnd(operations.map(operationLabel))}`;
}

/**
 * What still works when an OPTIONAL operation is missing. Spelled per
 * operation so the sentence names what is lost: insights lose the session
 * map without embeddings, never their text analysis. An operation that
 * can't run on organization providers yet says "not supported yet" rather
 * than "unavailable", which would read as something to configure, and one
 * waiting on an organization model nobody chose says which model.
 */
export function degradationSentence(
  feature: AiFeatureGroupId,
  operation: AiOperationId,
  status?: AiReadinessStatus,
  /** The organization model the operation waits on ({@link operationModelFix}). */
  waitsOn?: OrgAiModelKind,
): string {
  const state =
    status === "unsupported"
      ? "not supported yet"
      : waitsOn
        ? `unavailable until the organization's ${orgAiModelNoun(waitsOn)} is set`
        : "unavailable";
  const lost = (what: string, stillRuns: string) =>
    `${what} ${state}; ${stillRuns}`;
  if (operation === "embedding") {
    return feature === "insights"
      ? lost("Session map", "text insights still run")
      : lost("Clustering", "everything else still runs");
  }
  if (operation === "typed_decision") {
    return lost(
      "Automatic titles and classification",
      "everything else still runs",
    );
  }
  if (operation === "text_analysis" && feature === "evals") {
    return lost("Automatic findings", "runs and grading still complete");
  }
  if (operation === "judge") {
    return lost("Grading", "runs still complete");
  }
  if (operation === "speech_transcription") {
    return lost("Voice input", "everything else still runs");
  }
  const label = operationLabel(operation);
  return lost(
    `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
    "everything else still runs",
  );
}

// ---------------------------------------------------------------------------
// The organization's AI models for background work
// ---------------------------------------------------------------------------

/** Each kind's name and the work that runs on it. */
export const ORG_AI_MODEL_PRESENTATION: Record<
  OrgAiModelKind,
  { label: string; noun: string; runs: string }
> = {
  default: {
    label: "Default AI model",
    noun: "default AI model",
    runs: "Insights and findings, generation, typed decisions and simulated users",
  },
  embedding: {
    label: "Embedding model",
    noun: "embedding model",
    runs: "Session map and clustering",
  },
  transcription: {
    label: "Transcription model",
    noun: "transcription model",
    runs: "Voice input",
  },
};

/** "default AI model", "embedding model", "transcription model". */
export function orgAiModelNoun(kind: OrgAiModelKind): string {
  return ORG_AI_MODEL_PRESENTATION[kind]?.noun ?? `${kind} model`;
}

/** The fix for {@link operationModelFix}, by audience. */
export function orgAiModelGuidance(
  fix: { kind: OrgAiModelKind; reason: "unset" | "unusable" },
  canManage: boolean,
): string {
  const noun = orgAiModelNoun(fix.kind);
  if (fix.reason === "unusable") {
    return canManage
      ? `The organization's ${noun} can't run. Choose another below.`
      : `The organization's ${noun} can't run. Ask an organization admin to choose another.`;
  }
  return canManage
    ? `The organization's ${noun} isn't set. Choose it below.`
    : `The organization's ${noun} isn't set. Ask an organization admin to choose it.`;
}

/**
 * Whether a model id a connection lists fits a kind, by its name. Only
 * filters the editor's suggestions; any model can still be typed, and the
 * backend decides.
 */
export function listedModelFitsKind(
  modelId: string,
  kind: OrgAiModelKind,
): boolean {
  const id = modelId.toLowerCase();
  const embedding = id.includes("embed");
  const speech = /transcri|whisper/.test(id);
  if (kind === "embedding") return embedding;
  if (kind === "transcription") return speech;
  return !embedding && !speech;
}

/** How the last test of a saved model reads. */
export function orgAiModelCheckPresentation(check: OrgAiModelCheck): {
  label: string;
  tone: StatusTone;
} {
  if (check.ok) return { label: "Passed", tone: "success" };
  const code = check.code ?? "";
  if (["provider_auth_failed", "http_401", "http_403"].includes(code)) {
    return { label: "Credentials rejected", tone: "destructive" };
  }
  if (
    code === "provider_unavailable" ||
    code === "timeout" ||
    code === "http_408" ||
    code === "http_429" ||
    /^http_5\d{2}$/.test(code)
  ) {
    return { label: "Provider unavailable", tone: "warning" };
  }
  if (code) return { label: "Refused", tone: "destructive" };
  return { label: "Failed", tone: "destructive" };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  xai: "xAI",
  moonshotai: "Moonshot AI",
  "z-ai": "Z.ai",
  qwen: "Qwen",
  minimax: "MiniMax",
  azure: "Azure OpenAI",
  bedrock: "Amazon Bedrock",
  ollama: "Ollama",
  openrouter: "OpenRouter",
};

/** A connection's name as the provider list shows it. */
export function orgProviderLabel(provider: OrgModelProvider): string {
  if (provider.displayName?.trim()) return provider.displayName.trim();
  const known = PROVIDER_NAMES[provider.providerKey];
  if (known) return known;
  if (provider.providerKey.startsWith("custom:")) {
    return provider.providerKey.slice("custom:".length);
  }
  return provider.providerKey;
}

/** Model ids an admin listed on the connection, for the editor's suggestions. */
export function listedModelIds(provider: OrgModelProvider): string[] {
  const seen = new Set<string>();
  for (const raw of [
    ...(provider.modelIds ?? []),
    ...(provider.selectedModels ?? []),
  ]) {
    const id = raw.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * The canonical `provider/model` id and the provider's own id for a model an
 * admin typed against a connection. A pasted `provider/` prefix is dropped
 * from the native id, which is what the provider API is called with (for
 * Azure: the deployment name).
 *
 * The canonical id is the one a model picker saves for this connection's row
 * of the model (`canonicalSelectionModelId`), so this card and every picker
 * save the same id for the same connection. A model the pickers can't place
 * (one newer than the catalog, an Azure deployment name) keeps the
 * provider's canonical prefix, spelled as the pickers spell it.
 */
export function orgModelIds(
  providerKey: string,
  typed: string,
): { modelId: string; nativeModelId: string } | null {
  const raw = typed.trim();
  if (!raw) return null;
  const key = providerKey.trim().toLowerCase();
  if (!key) return null;
  const prefix = canonicalPrefix(key);

  let native = raw;
  for (const candidate of new Set([prefix, key])) {
    if (native.toLowerCase().startsWith(`${candidate}/`)) {
      native = native.slice(candidate.length + 1);
      break;
    }
  }
  if (!native) return null;

  const row: ModelDefinition = {
    id: native.includes("/") ? `${prefix}/${native}` : native,
    name: native,
    provider: key,
    hosted: false,
  };
  const modelId = canonicalSelectionModelId(row) ?? `${prefix}/${native}`;
  return { modelId, nativeModelId: native };
}

/**
 * The selection to save for an organization AI model: always `source:
 * "org"`, always naming the connection and the provider's native id, never
 * falling back to another model. `null` when the typed model cannot form a
 * valid selection.
 */
export function buildOrgModelSelection(
  provider: Pick<OrgModelProvider, "id" | "providerKey">,
  typedModel: string,
): ModelSelection | null {
  const connectionId = provider.id?.trim();
  if (!connectionId) return null;
  const ids = orgModelIds(provider.providerKey, typedModel);
  if (!ids) return null;
  const result = validateModelSelection({
    modelId: ids.modelId,
    source: "org",
    connectionRef: { kind: "orgProvider", id: connectionId },
    nativeModelId: ids.nativeModelId,
    fallback: { provider: "none", model: "none" },
  });
  return result.ok ? result.selection : null;
}

/** The model a saved selection runs, as the admin would recognise it. */
export function selectionModelLabel(selection: ModelSelection): string {
  const native = selection.nativeModelId?.trim();
  const tail = selection.modelId.slice(selection.modelId.indexOf("/") + 1);
  return native && native !== tail
    ? `${selection.modelId} (${native})`
    : selection.modelId;
}
