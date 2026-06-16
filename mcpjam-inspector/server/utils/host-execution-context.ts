/**
 * Shared resolver: hostConfig record + per-call overrides → resolved execution fields.
 *
 * Engine consolidation PR 4c (`~/mcpjam-docs/unification.md`). Until this
 * lands, every caller that drove the chat/eval engines did its own
 * hostConfig-to-fields read inline. The reads drifted: chat-v2 (mcp +
 * web) routes resolved `systemPrompt` / `temperature` / `requireToolApproval`
 * / `respectToolVisibility` / `progressiveToolDiscovery` / `modelId` from
 * `fetchChatboxRuntimeConfig` for chatbox sessions; the eval runner only
 * extracted policy fields (`extractHostExecutionPolicy`) from
 * `suiteHostConfig` and never read `systemPrompt` / `temperature` /
 * `selectedServerIds` — even though the suite hostConfig record carries
 * them. The eval client deliberately does NOT bake the suite default
 * into per-case `advancedConfig` (see
 * `client/src/components/evals/use-eval-handlers.ts:302`) on the
 * understanding that the runtime applies it; the runtime never did.
 *
 * This resolver subsumes both shapes. Callers pass a hostConfig (or
 * null), per-call overrides, and a precedence mode; the resolver runs
 * the field-by-field merge plus the existing
 * `extractHostExecutionPolicy` derivation and emits a single
 * `ResolvedExecutionContext`. Drift between override and host is
 * captured as data — the caller decides whether to log per-field
 * warnings (chat does today; eval probably won't).
 *
 * PR 4c is a pure refactor on the chat side — `resolveExecutionContext`
 * is wired into `mcp/chat-v2.ts` + `web/chat-v2.ts` with shape-preserving
 * snapshot tests. PR 4d wires eval onto it and closes the
 * suite-systemPrompt gap (behavior change; called out separately).
 *
 * Lives inspector-side so it can iterate without a SDK publish cycle.
 * If the contract stabilizes it can be promoted to
 * `@mcpjam/sdk/host-config/internal` alongside `extractHostExecutionPolicy`.
 */

import {
  extractHostExecutionPolicy,
  type HostExecutionPolicy,
} from "@mcpjam/sdk/host-config/internal";

/**
 * How the resolver picks a winner when both the hostConfig and the
 * caller-supplied overrides provide a value for the same field.
 *
 * - `host-wins`: hostConfig value beats override (chat chatbox security
 *   model — guest / share-link clients can't bypass the host's pinned
 *   config). Override only used when the host omits the field.
 * - `override-wins`: caller's override beats hostConfig value (eval
 *   per-case `advancedConfig` shape — explicit case-level overrides
 *   beat the suite default). Host fills in when the override is
 *   undefined.
 *
 * When `hostConfig` is `null` the precedence doesn't matter — the
 * resolver returns the overrides as-is.
 */
export type ResolverPrecedence = "host-wins" | "override-wins";

/**
 * Per-call overrides layered on top of (or under, per `precedence`) the
 * hostConfig record. All fields optional — `undefined` means "no
 * override; use hostConfig value (or fall back to default)."
 */
export interface ExecutionOverrides {
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  progressiveToolDiscovery?: boolean;
  modelId?: string;
  selectedServerIds?: string[];
  builtInToolIds?: string[];
}

/**
 * Record of a field where the override and the hostConfig disagreed.
 * The resolver emits one entry per drifted field; callers choose
 * whether to surface them as warnings (chat-v2 does so per-field with a
 * `logger.warn` shape, eval may stash them on metadata or ignore).
 *
 * Drift is only reported when BOTH sources have a defined value and
 * the values differ — pure missing-side fallback is not drift.
 */
export interface ExecutionDriftEntry {
  field: keyof ExecutionOverrides;
  overrideValue: unknown;
  hostValue: unknown;
}

/**
 * Resolved execution fields plus the policy block. Subsumes everything
 * downstream code (`prepareChatV2`, `runDirectChatTurn`, `runAssistantTurn`,
 * eval runners) needs from the host execution context.
 *
 * `hostPolicy` is the existing `HostExecutionPolicy` extracted via
 * `extractHostExecutionPolicy` — kept on the result so callers don't
 * have to call both helpers. Note that `hostPolicy.requireToolApproval`
 * / `hostPolicy.respectToolVisibility` reflect the HOST record alone,
 * whereas the top-level fields reflect the RESOLVED value (host vs
 * override per precedence). Both are useful; eval uses the policy
 * block for `buildHostIterationMetadata`, chat uses the resolved
 * fields for the model call.
 */
export interface ResolvedExecutionContext {
  systemPrompt: string | undefined;
  temperature: number | undefined;
  requireToolApproval: boolean;
  respectToolVisibility: boolean | undefined;
  progressiveToolDiscovery: boolean | undefined;
  modelId: string | undefined;
  /** Which real agent harness runs the turn (host-level). Absent ⇒ emulated. */
  harness: "claude-code" | undefined;
  selectedServerIds: string[] | undefined;
  /**
   * HostConfig v2 built-in tool ids (e.g. `["web_search"]`). The resolver
   * only surfaces the resolved id list; turning ids into runnable AI SDK
   * tools (and deciding whether auth context permits it) is owned by
   * `built-in-tools/registry.ts` at the call site.
   */
  builtInToolIds: string[] | undefined;
  hostPolicy: HostExecutionPolicy;
  drift: ExecutionDriftEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(
  hostConfig: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = hostConfig[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  hostConfig: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = hostConfig[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(
  hostConfig: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = hostConfig[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(
  hostConfig: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = hostConfig[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
}

/**
 * Progressive discovery is stored as a plain boolean on `hostConfigV2`
 * records (`progressiveToolDiscovery: true`) BUT as `{ enabled, threshold }`
 * on chat-v2 wire payloads. Mirror `extractHostExecutionPolicy`'s dual
 * read so the resolver accepts both shapes.
 */
function readProgressiveToolDiscovery(
  hostConfig: Record<string, unknown>,
): boolean | undefined {
  const raw = hostConfig.progressiveToolDiscovery;
  if (typeof raw === "boolean") return raw;
  if (isRecord(raw) && raw.enabled === true) return true;
  if (isRecord(raw) && raw.enabled === false) return false;
  return undefined;
}

/**
 * Value equality for drift detection. Array fields (`selectedServerIds`,
 * `builtInToolIds`) arrive as fresh allocations on every request — a
 * reference compare would report drift for identical contents.
 */
function areEqualValues(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return Object.is(a, b);
}

/**
 * Pick the winning value for a field given the resolver precedence.
 * Returns the winner AND, if both sides disagreed, a drift entry the
 * caller can log.
 */
function pickField<T>(
  field: keyof ExecutionOverrides,
  override: T | undefined,
  host: T | undefined,
  precedence: ResolverPrecedence,
): { value: T | undefined; drift?: ExecutionDriftEntry } {
  const overrideDefined = override !== undefined;
  const hostDefined = host !== undefined;
  if (!overrideDefined && !hostDefined) {
    return { value: undefined };
  }
  if (!overrideDefined) {
    return { value: host };
  }
  if (!hostDefined) {
    return { value: override };
  }
  // Both defined — apply precedence + record drift when they differ.
  const drift =
    !areEqualValues(override, host)
      ? {
          field,
          overrideValue: override as unknown,
          hostValue: host as unknown,
        }
      : undefined;
  const winner = precedence === "host-wins" ? host : override;
  return drift ? { value: winner, drift } : { value: winner };
}

/** Read the host-level `harness` selector. Only the known value is surfaced;
 *  anything else (or absent) ⇒ undefined (emulated). */
function readHarness(
  hostConfig: Record<string, unknown>,
): "claude-code" | undefined {
  return hostConfig.harness === "claude-code" ? "claude-code" : undefined;
}

export function resolveExecutionContext(args: {
  hostConfig: Record<string, unknown> | null;
  overrides?: ExecutionOverrides;
  precedence: ResolverPrecedence;
  namedHostId?: string;
}): ResolvedExecutionContext {
  const { hostConfig, overrides = {}, precedence, namedHostId } = args;
  const hostPolicy = extractHostExecutionPolicy(hostConfig, namedHostId);
  const drift: ExecutionDriftEntry[] = [];

  // hostConfig === null short-circuit: no host values, return overrides
  // as-is. `requireToolApproval` still has its boolean-default semantic.
  if (!hostConfig) {
    return {
      systemPrompt: overrides.systemPrompt,
      temperature: overrides.temperature,
      requireToolApproval: overrides.requireToolApproval ?? false,
      respectToolVisibility: overrides.respectToolVisibility,
      progressiveToolDiscovery: overrides.progressiveToolDiscovery,
      modelId: overrides.modelId,
      harness: undefined,
      selectedServerIds: overrides.selectedServerIds,
      builtInToolIds: overrides.builtInToolIds,
      hostPolicy,
      drift,
    };
  }

  const hostFields = {
    systemPrompt: readString(hostConfig, "systemPrompt"),
    temperature: readNumber(hostConfig, "temperature"),
    requireToolApproval: readBoolean(hostConfig, "requireToolApproval"),
    respectToolVisibility: readBoolean(hostConfig, "respectToolVisibility"),
    progressiveToolDiscovery: readProgressiveToolDiscovery(hostConfig),
    modelId: readString(hostConfig, "modelId"),
    selectedServerIds: readStringArray(hostConfig, "selectedServerIds"),
    builtInToolIds: readStringArray(hostConfig, "builtInToolIds"),
  };

  const systemPrompt = pickField(
    "systemPrompt",
    overrides.systemPrompt,
    hostFields.systemPrompt,
    precedence,
  );
  if (systemPrompt.drift) drift.push(systemPrompt.drift);

  const temperature = pickField(
    "temperature",
    overrides.temperature,
    hostFields.temperature,
    precedence,
  );
  if (temperature.drift) drift.push(temperature.drift);

  const requireToolApprovalPick = pickField(
    "requireToolApproval",
    overrides.requireToolApproval,
    hostFields.requireToolApproval,
    precedence,
  );
  if (requireToolApprovalPick.drift) drift.push(requireToolApprovalPick.drift);

  const respectToolVisibility = pickField(
    "respectToolVisibility",
    overrides.respectToolVisibility,
    hostFields.respectToolVisibility,
    precedence,
  );
  if (respectToolVisibility.drift) drift.push(respectToolVisibility.drift);

  const progressiveToolDiscovery = pickField(
    "progressiveToolDiscovery",
    overrides.progressiveToolDiscovery,
    hostFields.progressiveToolDiscovery,
    precedence,
  );
  if (progressiveToolDiscovery.drift) drift.push(progressiveToolDiscovery.drift);

  const modelId = pickField(
    "modelId",
    overrides.modelId,
    hostFields.modelId,
    precedence,
  );
  if (modelId.drift) drift.push(modelId.drift);

  const selectedServerIds = pickField(
    "selectedServerIds",
    overrides.selectedServerIds,
    hostFields.selectedServerIds,
    precedence,
  );
  if (selectedServerIds.drift) drift.push(selectedServerIds.drift);

  const builtInToolIds = pickField(
    "builtInToolIds",
    overrides.builtInToolIds,
    hostFields.builtInToolIds,
    precedence,
  );
  if (builtInToolIds.drift) drift.push(builtInToolIds.drift);

  return {
    systemPrompt: systemPrompt.value,
    temperature: temperature.value,
    // `requireToolApproval` defaults to `false` (boolean-required slot).
    requireToolApproval: requireToolApprovalPick.value ?? false,
    respectToolVisibility: respectToolVisibility.value,
    progressiveToolDiscovery: progressiveToolDiscovery.value,
    modelId: modelId.value,
    harness: readHarness(hostConfig),
    selectedServerIds: selectedServerIds.value,
    builtInToolIds: builtInToolIds.value,
    hostPolicy,
    drift,
  };
}
