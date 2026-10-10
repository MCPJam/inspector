/**
 * Words and shapes for the "Use your keys for all AI features" settings.
 *
 * Pure: no React, no network. Kept apart from the cards so the copy rules
 * (never imply text insights need embeddings; configuration problems read as
 * "Unavailable", never as a spinner) live in one place and are testable.
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
  OrgAiModelRole,
  OrgAiModelRoleCheckOutcome,
} from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";

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

/** What to do about a status, in the reader's terms. */
export function statusGuidance(
  status: AiReadinessStatus,
  canManage: boolean,
): string | null {
  switch (status) {
    case "unconfigured":
      return canManage
        ? "Add or configure an organization provider."
        : "Ask an organization admin to add or configure an organization provider.";
    case "unsupported":
      return "This feature can't run on organization providers yet.";
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

/** Where an admin picks the organization's model for each role. */
export const MODEL_ROLES_SECTION = "Default model roles";

/**
 * What to do about a feature that is not ready. An unavailable feature whose
 * blockers are role models, while an eligible provider exists, is fixed by
 * choosing those models in {@link MODEL_ROLES_SECTION}; adding a provider is
 * the fix only when there is no eligible one. Every other status reads as
 * {@link statusGuidance}.
 */
export function featureGuidance(
  feature: AiFeatureGroupReadiness,
  context: {
    operations: readonly AiOperationReadiness[];
    /** The backend's eligible connections; absent on an older backend. */
    eligibleConnectionIds?: readonly string[];
    canManage: boolean;
  },
): string | null {
  if (feature.status === "ready") return null;
  if (
    feature.status === "unconfigured" &&
    (context.eligibleConnectionIds?.length ?? 0) > 0
  ) {
    const roles = [
      ...new Set(
        (feature.blockedBy ?? []).flatMap((id) => {
          const role = context.operations.find(
            (operation) => operation.operation === id,
          )?.role;
          return role && ORG_AI_ROLE_PRESENTATION[role] ? [role] : [];
        }),
      ),
    ];
    if (roles.length > 0) {
      const names = roles.map((role) => ORG_AI_ROLE_PRESENTATION[role].label);
      const list =
        names.length === 1
          ? names[0]
          : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      const noun = names.length === 1 ? "model" : "models";
      return context.canManage
        ? `Choose the organization's ${list} ${noun} in ${MODEL_ROLES_SECTION}.`
        : `Ask an organization admin to choose the organization's ${list} ${noun}.`;
    }
  }
  return statusGuidance(feature.status, context.canManage);
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
 * The operations a feature's "Blocked by" line names. Empty when the only
 * blocker is the feature itself ("Ask MCPJam" blocked by Ask MCPJam): the
 * status and its guidance already say everything that line would.
 */
export function listedBlockers(
  feature: AiFeatureGroupReadiness,
): AiOperationId[] {
  if (feature.status === "ready") return [];
  const blockedBy = feature.blockedBy ?? [];
  return blockedBy.length === 1 &&
    blockedBy[0] === FEATURE_OWN_OPERATION[feature.id]
    ? []
    : blockedBy;
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

/**
 * What still works when an OPTIONAL operation is missing. Spelled per
 * operation so the sentence names what is lost: insights lose the session
 * map without embeddings, never their text analysis.
 */
export function degradationSentence(
  feature: AiFeatureGroupId,
  operation: AiOperationId,
): string {
  if (operation === "embedding") {
    return feature === "insights"
      ? "Session map unavailable; text insights still run"
      : "Clustering unavailable; everything else still runs";
  }
  if (operation === "typed_decision") {
    return "Automatic titles and classification unavailable; everything else still runs";
  }
  if (operation === "judge") {
    return "Grading unavailable; runs still complete";
  }
  if (operation === "speech_transcription") {
    return "Voice input unavailable; everything else still runs";
  }
  const label = operationLabel(operation);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} unavailable; everything else still runs`;
}

// ---------------------------------------------------------------------------
// Model roles
// ---------------------------------------------------------------------------

export const ORG_AI_ROLE_PRESENTATION: Record<
  OrgAiModelRole,
  { label: string; features: string }
> = {
  fast: {
    label: "Fast",
    features: "Typed decisions, titles, classification",
  },
  smart: {
    label: "Smart",
    features: "Analysis, generation, simulated users",
  },
  embedding: { label: "Embedding", features: "Session map, clustering" },
  transcription: { label: "Transcription", features: "Voice input" },
};

export const ROLE_CHECK_OUTCOME_PRESENTATION: Record<
  OrgAiModelRoleCheckOutcome,
  { label: string; tone: StatusTone }
> = {
  ok: { label: "Passed", tone: "success" },
  auth_failed: { label: "Credentials rejected", tone: "destructive" },
  unavailable: { label: "Provider unavailable", tone: "warning" },
  refused: { label: "Refused", tone: "destructive" },
  failed: { label: "Failed", tone: "destructive" },
};

export function roleCheckOutcomePresentation(
  outcome: OrgAiModelRoleCheckOutcome,
): { label: string; tone: StatusTone } {
  return (
    ROLE_CHECK_OUTCOME_PRESENTATION[outcome] ?? {
      label: outcome,
      tone: "muted",
    }
  );
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
 * Canonical vendor prefix for a provider key, where it differs from the key
 * (the canonical catalog spells these `x-ai/`, `mistralai/`).
 */
const CANONICAL_PROVIDER_PREFIX: Readonly<Record<string, string>> = {
  xai: "x-ai",
  mistral: "mistralai",
};

/**
 * Anthropic's API spells a model version with a dash (`claude-haiku-4-5`);
 * the canonical catalog spells it with a dot (`anthropic/claude-haiku-4.5`).
 */
const ANTHROPIC_DASHED_VERSION = /^(claude-(?:haiku|sonnet|opus))-(\d+)-(\d)$/;

/**
 * The canonical `provider/model` id and the provider's own id for a model an
 * admin typed against a connection. A pasted `provider/` prefix is dropped
 * from the native id, which is what the provider API is called with (for
 * Azure: the deployment name).
 */
export function roleModelIds(
  providerKey: string,
  typed: string,
): { modelId: string; nativeModelId: string } | null {
  const raw = typed.trim();
  if (!raw) return null;
  const key = providerKey.trim().toLowerCase();
  if (!key) return null;
  const prefix = CANONICAL_PROVIDER_PREFIX[key] ?? key;

  let native = raw;
  for (const candidate of new Set([prefix, key])) {
    if (native.toLowerCase().startsWith(`${candidate}/`)) {
      native = native.slice(candidate.length + 1);
      break;
    }
  }
  if (!native) return null;

  const tail =
    key === "anthropic"
      ? native.replace(ANTHROPIC_DASHED_VERSION, "$1-$2.$3")
      : native;
  return { modelId: `${prefix}/${tail}`, nativeModelId: native };
}

/**
 * The saved selection for a role: always `source: "org"`, always naming the
 * connection and the provider's native id, never falling back to another
 * model. `null` when the typed model cannot form a valid selection.
 */
export function buildOrgRoleSelection(
  provider: Pick<OrgModelProvider, "id" | "providerKey">,
  typedModel: string,
): ModelSelection | null {
  const connectionId = provider.id?.trim();
  if (!connectionId) return null;
  const ids = roleModelIds(provider.providerKey, typedModel);
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
