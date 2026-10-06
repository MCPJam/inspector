/**
 * OpenAI extension keys are pinned to mcp-extensions 93a30a92 / 0.1.0.
 * This module owns advertisement AND dispatch admission. It is browser-safe;
 * official schema adapters and existing authorization services are injected.
 */
import type { PluginExtensionCapabilityKey } from "../host-config/types.js";

export const PLUGIN_FEATURES = [
  "global-entrypoint",
  "thread-entrypoint",
  "file-entrypoint",
  "quick-actions",
  "settings",
  "onboarding",
  "mentions",
  "deep-links",
  "display",
  "messages",
  "model-context",
  "resources",
  "file-open",
  "forms",
  "automation",
  "replay",
  "cleanup",
] as const;
export type PluginFeature = (typeof PLUGIN_FEATURES)[number];
export type PluginCapabilityStatus =
  | "supported"
  | "degraded"
  | "blocked"
  | "unsupported"
  | "unimplemented";
export type PluginService =
  | "authorized-invocation"
  | "thread-turn"
  | "engine-input"
  | "instance-context"
  | "resource-grants"
  | "file-open"
  | "form-ui"
  | "form-storage"
  | "automation"
  | "recording-read"
  | "inert-render"
  | "release";
export interface PluginFeatureBinding {
  coverage: "complete" | "partial";
  /** Must reject the WHOLE unsupported request before invoking a live port. */
  validate: (params: unknown) => boolean;
  invoke: (
    params: unknown,
    context: { signal?: AbortSignal }
  ) => Promise<unknown>;
}
/**
 * The emulated client. There is deliberately no platform: which extensions a
 * client supports comes from its own per-extension toggles (fed in as
 * `disabledFeatures`), never from a responsive-design hint or from where the
 * host is deployed. Desktop-only features (file viewers, mentions, file
 * resources, local files) are off only when the client turns them off.
 */
export interface PluginCapabilityProfile {
  runtime: "chatgpt-emulated" | "codex";
  transport: "legacy" | "mrtr";
  mode?: "live" | "replay";
  disabledFeatures?: readonly PluginFeature[];
  /** Explicit prototype opt-in; a passed fixture never changes its authority. */
  allowAssumedMrtrForms?: boolean;
}
export interface PluginCapabilityDecision {
  feature: string;
  status: PluginCapabilityStatus;
  allowed: boolean;
  authority: "specified" | "assumed";
  reason?: string;
}

const READ_ONLY = new Set<PluginFeature>(["replay", "cleanup"]);
const REPLAY_SERVICES = new Set<PluginService>([
  "recording-read",
  "inert-render",
  "release",
]);
const ENGINE_DEPENDENT = new Set<PluginFeature>([
  "onboarding",
  "messages",
  "model-context",
  "automation",
]);
const SERVICES: Partial<Record<PluginFeature, readonly PluginService[]>> = {
  "global-entrypoint": ["authorized-invocation"],
  "thread-entrypoint": ["authorized-invocation"],
  "file-entrypoint": ["authorized-invocation", "resource-grants"],
  "quick-actions": ["authorized-invocation"],
  settings: ["authorized-invocation", "form-ui"],
  onboarding: ["thread-turn", "engine-input"],
  mentions: ["authorized-invocation", "thread-turn", "resource-grants"],
  "deep-links": ["authorized-invocation"],
  display: ["instance-context"],
  messages: ["thread-turn", "engine-input"],
  "model-context": ["instance-context", "engine-input"],
  resources: ["resource-grants"],
  "file-open": ["resource-grants", "file-open"],
  forms: [
    "form-ui",
    "form-storage",
    "resource-grants",
    "authorized-invocation",
  ],
  automation: [
    "automation",
    "thread-turn",
    "engine-input",
    "authorized-invocation",
  ],
  replay: ["recording-read", "inert-render"],
  cleanup: ["release"],
};
// The pinned App helper reads these from hostCapabilities.experimental.
const HOST_KEYS: Partial<Record<PluginFeature, string>> = {
  messages: "openai/message",
  "model-context": "openai/modelContext",
  resources: "openai/resource",
  "file-open": "openai/files",
};

/**
 * Which plugin features each per-client toggle
 * (`mcpProfile.apps.pluginExtensions.capabilities`) controls. Feed the result
 * of {@link disabledPluginFeatures} to `profile.disabledFeatures` so a client
 * that switched an extension off stops advertising and dispatching it.
 */
export const PLUGIN_EXTENSION_TOGGLE_FEATURES: Readonly<
  Record<PluginExtensionCapabilityKey, readonly PluginFeature[]>
> = {
  sidebarApps: ["global-entrypoint"],
  conversationPanels: ["thread-entrypoint"],
  fileViewers: ["file-entrypoint"],
  fileResources: ["resources"],
  localFiles: ["file-open"],
  settings: ["settings"],
  displayModes: ["display"],
  deepLinks: ["deep-links"],
  modelContext: ["model-context"],
  messages: ["messages"],
  mentions: ["mentions"],
  forms: ["forms"],
  onboarding: ["onboarding"],
};

/** Features to disable for a client's resolved per-extension toggles. */
export function disabledPluginFeatures(
  capabilities: Readonly<Partial<Record<PluginExtensionCapabilityKey, boolean>>>
): PluginFeature[] {
  const disabled = new Set<PluginFeature>();
  for (const [toggle, features] of Object.entries(
    PLUGIN_EXTENSION_TOGGLE_FEATURES
  ) as Array<[PluginExtensionCapabilityKey, readonly PluginFeature[]]>) {
    if (capabilities[toggle] === false)
      for (const feature of features) disabled.add(feature);
  }
  return PLUGIN_FEATURES.filter((feature) => disabled.has(feature));
}

export class PluginCapabilityError extends Error {
  constructor(readonly decision: PluginCapabilityDecision) {
    super(decision.reason ?? "PLUGIN_FEATURE_UNAVAILABLE");
    this.name = "PluginCapabilityError";
  }
}

/** Never let a preset, stale recording or browser override assert our keys. */
function withoutOpenAIClaims(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith("openai/"))
  );
}

export function createPluginCapabilityRegistry(input: {
  profile: PluginCapabilityProfile;
  /** Live admission/readiness snapshot, never a grant of server authority. */
  executionEnabled: () => boolean;
  bindings: Partial<Record<PluginFeature, PluginFeatureBinding>>;
  /** Port bindings, not client-provided boolean capability claims. */
  services: Partial<Record<PluginService, { available: () => boolean }>>;
  engineCoverage?: Partial<Record<PluginFeature, "complete" | "partial">>;
}) {
  const profile = structuredClone(input.profile);
  if (
    !["chatgpt-emulated", "codex"].includes(profile.runtime) ||
    !["legacy", "mrtr"].includes(profile.transport) ||
    (profile.mode !== undefined && !["live", "replay"].includes(profile.mode))
  )
    throw new Error("INVALID_PLUGIN_PROFILE");
  const disabled = new Set(profile.disabledFeatures ?? []);
  if ([...disabled].some((feature) => !PLUGIN_FEATURES.includes(feature)))
    throw new Error("INVALID_PLUGIN_PROFILE");
  const executionEnabled = input.executionEnabled;
  const bindings = new Map<PluginFeature, PluginFeatureBinding>();
  for (const feature of PLUGIN_FEATURES) {
    if (!Object.hasOwn(input.bindings, feature)) continue;
    const binding = input.bindings[feature];
    if (!binding) continue;
    if (
      typeof binding.invoke !== "function" ||
      typeof binding.validate !== "function" ||
      !["complete", "partial"].includes(binding.coverage)
    )
      throw new Error("INVALID_PLUGIN_BINDING");
    if (profile.mode === "replay" && !READ_ONLY.has(feature))
      throw new Error("REPLAY_LIVE_BINDING");
    bindings.set(feature, { ...binding });
  }
  const services = new Map<PluginService, () => boolean>();
  for (const [service, port] of Object.entries(input.services)) {
    if (
      profile.mode === "replay" &&
      port &&
      !REPLAY_SERVICES.has(service as PluginService)
    )
      throw new Error("REPLAY_LIVE_SERVICE");
    if (port && typeof port.available === "function")
      services.set(service as PluginService, port.available);
  }
  const engineCoverage = { ...input.engineCoverage };
  const available = (check?: () => boolean) => {
    try {
      return check?.() === true;
    } catch {
      return false;
    }
  };
  const decision = (feature: string): PluginCapabilityDecision => {
    const known = PLUGIN_FEATURES.includes(feature as PluginFeature);
    const id = feature as PluginFeature;
    const authority =
      id === "forms" && profile.transport === "mrtr" ? "assumed" : "specified";
    const result = (
      status: PluginCapabilityStatus,
      reason?: string
    ): PluginCapabilityDecision => ({
      feature,
      status,
      allowed: status === "supported",
      authority,
      ...(reason ? { reason } : {}),
    });
    if (!known) return result("unsupported", "UNKNOWN_PLUGIN_FEATURE");
    if (profile.mode === "replay" && !READ_ONLY.has(id))
      return result("blocked", "REPLAY_INERT");
    if (disabled.has(id) && id !== "cleanup")
      return result("blocked", "PROFILE_DISABLED");
    if (!READ_ONLY.has(id) && !available(executionEnabled))
      return result("blocked", "EXTENSIONS_DISABLED");
    const binding = bindings.get(id);
    if (!binding) return result("unimplemented", "HANDLER_UNIMPLEMENTED");
    if (binding.coverage !== "complete")
      return result("degraded", "HANDLER_INCOMPLETE");
    if (
      (SERVICES[id] ?? []).some((service) => !available(services.get(service)))
    )
      return result("blocked", "SERVICE_UNAVAILABLE");
    if (ENGINE_DEPENDENT.has(id) && engineCoverage[id] !== "complete")
      return result("degraded", "ENGINE_FIDELITY_INCOMPLETE");
    if (authority === "assumed" && profile.allowAssumedMrtrForms !== true)
      return result("degraded", "MRTR_EXTENSION_MAPPING_ASSUMED");
    return result("supported");
  };
  const snapshot = () =>
    Object.fromEntries(
      PLUGIN_FEATURES.map((feature) => [feature, decision(feature)])
    ) as Record<PluginFeature, PluginCapabilityDecision>;
  const hostCapabilities = (base: Record<string, unknown> = {}) => {
    const capabilities = structuredClone(base);
    const extensions = withoutOpenAIClaims(capabilities.extensions);
    if (Object.keys(extensions).length) capabilities.extensions = extensions;
    else delete capabilities.extensions;
    const experimental = withoutOpenAIClaims(capabilities.experimental);
    for (const [feature, key] of Object.entries(HOST_KEYS)) {
      if (decision(feature).allowed) experimental[key] = {};
    }
    if (Object.keys(experimental).length)
      capabilities.experimental = experimental;
    else delete capabilities.experimental;
    return capabilities;
  };
  const clientCapabilities = (base: Record<string, unknown> = {}) => {
    const capabilities = structuredClone(base);
    for (const field of ["extensions", "experimental"] as const) {
      const values = withoutOpenAIClaims(capabilities[field]);
      if (Object.keys(values).length) capabilities[field] = values;
      else delete capabilities[field];
    }
    if (decision("forms").allowed)
      capabilities.extensions = {
        ...(capabilities.extensions as Record<string, unknown> | undefined),
        "openai/elicitation": { form: {} },
      };
    return capabilities;
  };
  const invoke = async (
    feature: string,
    params: unknown,
    context: { signal?: AbortSignal } = {}
  ) => {
    context.signal?.throwIfAborted();
    const current = decision(feature);
    if (!current.allowed) throw new PluginCapabilityError(current);
    const binding = bindings.get(feature as PluginFeature)!;
    let value: unknown;
    let valid = false;
    try {
      value = structuredClone(params);
      valid = binding.validate(value) === true;
    } catch {
      /* Reject without echoing data. */
    }
    if (!valid)
      throw new PluginCapabilityError({
        ...current,
        status: "unsupported",
        allowed: false,
        reason: "PLUGIN_PARAMETERS_UNSUPPORTED",
      });
    // A validator may synchronously close its owner or disable the feature.
    const rechecked = decision(feature);
    if (!rechecked.allowed) throw new PluginCapabilityError(rechecked);
    context.signal?.throwIfAborted();
    return binding.invoke(value, context);
  };
  return { decision, snapshot, hostCapabilities, clientCapabilities, invoke };
}
