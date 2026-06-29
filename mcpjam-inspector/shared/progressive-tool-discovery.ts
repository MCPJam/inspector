/**
 * Progressive Tool Discovery: shared types, catalog construction, policy, search.
 *
 * The catalog is built once per turn from an AI SDK ToolSet. Each entry carries
 * a stable `toolId = serverId::toolName` (or `local::toolName` for non-MCP
 * tools), a model-facing name (already collision-safe at the ToolSet level),
 * server metadata, a description, summarized input fields, the full JSON
 * schema, and a token estimate.
 *
 * `decideProgressivePlan` chooses whether to keep the existing full-tool
 * behavior or switch to progressive mode. The defaults track the plan: 3% of
 * model context, 10k estimated tool tokens, or 30 available tools.
 *
 * `searchToolCatalog` is a small BM25-ish ranker over name + description +
 * field names. It is intentionally simple — the goal is "good enough to find
 * an obvious match", not state-of-the-art IR.
 */

import type { ToolSet } from "ai";

export const META_TOOL_SEARCH = "search_mcp_tools";
export const META_TOOL_LOAD = "load_mcp_tools";
export const META_TOOL_NAMES: readonly string[] = [
  META_TOOL_SEARCH,
  META_TOOL_LOAD,
] as const;

export interface ToolCatalogFieldSummary {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolCatalogEntry {
  /** Stable identifier across requests, never sent to the model. */
  toolId: string;
  /** AI SDK / ToolSet key — the name the model sees. */
  modelName: string;
  /** Underlying server/source identifier, or null for skill/local tools. */
  serverId: string | null;
  /** Original MCP tool name (before any inspector-side rename). */
  originalName: string;
  description?: string;
  fields: ToolCatalogFieldSummary[];
  /** Full JSON Schema (or `{}` if missing). */
  inputSchema: Record<string, unknown>;
  /** Rough token estimate of the full descriptor for budget math. */
  tokenEstimate: number;
}

export interface ToolDiscoveryPolicy {
  thresholdPct: number;
  maxToolTokens: number;
  maxToolCount: number;
  searchLimit: number;
}

export interface ToolDiscoveryState {
  /** Stable across the turn — used to filter the full ToolSet down. */
  loadedToolIds: Set<string>;
  /** Tool ids the model just asked for via load_mcp_tools on the prior step. */
  newlyLoadedToolIds: Set<string>;
  /** Tool ids with pending approvals — must remain exposed across steps. */
  pendingApprovalToolIds: Set<string>;
}

export type ProgressiveDiscoveryEnabled = "auto" | true | false;

export interface ProgressiveDiscoveryOptions {
  enabled?: ProgressiveDiscoveryEnabled;
  thresholdPct?: number;
  maxToolTokens?: number;
  maxToolCount?: number;
  searchLimit?: number;
}

export interface ProgressiveToolPlan {
  enabled: boolean;
  /** Reasons the policy fired, for logging / payload. */
  reasons: string[];
  policy: ToolDiscoveryPolicy;
  catalog: ToolCatalogEntry[];
  /** Total estimated tokens for the full set, before progressive filtering. */
  totalTokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TOOL_DISCOVERY_POLICY: ToolDiscoveryPolicy = {
  thresholdPct: 0.03,
  maxToolTokens: 10_000,
  maxToolCount: 30,
  searchLimit: 8,
};

export function resolveDiscoveryPolicy(
  opts?: ProgressiveDiscoveryOptions,
): ToolDiscoveryPolicy {
  return {
    thresholdPct: opts?.thresholdPct ?? DEFAULT_TOOL_DISCOVERY_POLICY.thresholdPct,
    maxToolTokens:
      opts?.maxToolTokens ?? DEFAULT_TOOL_DISCOVERY_POLICY.maxToolTokens,
    maxToolCount:
      opts?.maxToolCount ?? DEFAULT_TOOL_DISCOVERY_POLICY.maxToolCount,
    searchLimit:
      opts?.searchLimit ?? DEFAULT_TOOL_DISCOVERY_POLICY.searchLimit,
  };
}

/**
 * Read MCPJAM_PROGRESSIVE_TOOLS from a string env value. Unknown / unset →
 * undefined so the caller can fall back to its own default.
 */
export function parseProgressiveToolsEnv(
  raw: string | undefined,
): ProgressiveDiscoveryEnabled | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "auto") return "auto";
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Cheap token approximation: 1 token per ~4 characters. Within ~25% of real
 * tokenizers for English JSON and good enough to drive the policy decision
 * (which is only ever a coarse threshold). We intentionally avoid loading a
 * real tokenizer here — this runs on every chat turn and must stay cheap.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateEntryTokens(entry: {
  modelName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}): number {
  const schemaText = safeStringify(entry.inputSchema);
  return (
    estimateTokens(entry.modelName) +
    estimateTokens(entry.description ?? "") +
    estimateTokens(schemaText) +
    // Per-tool framing overhead in provider tool-list serialization.
    8
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Catalog construction
// ---------------------------------------------------------------------------

type AnyTool = {
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  _serverId?: unknown;
  _meta?: unknown;
  // Some MCP-adapter tools stash the original MCP name when the AI SDK name
  // was sanitized for provider naming rules.
  _originalName?: unknown;
};

function readJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {};
  }
  // AI SDK zodSchema wraps the raw JSON Schema as `.jsonSchema`.
  const withJsonSchema = schema as { jsonSchema?: unknown };
  if (
    withJsonSchema.jsonSchema &&
    typeof withJsonSchema.jsonSchema === "object"
  ) {
    return withJsonSchema.jsonSchema as Record<string, unknown>;
  }
  // Already a plain JSON Schema object.
  return schema as Record<string, unknown>;
}

function summarizeFields(
  inputSchema: Record<string, unknown>,
): ToolCatalogFieldSummary[] {
  const props = (inputSchema?.properties ?? {}) as Record<string, unknown>;
  const requiredList = Array.isArray(inputSchema?.required)
    ? (inputSchema.required as unknown[]).filter(
        (n): n is string => typeof n === "string",
      )
    : [];
  const required = new Set(requiredList);
  const fields: ToolCatalogFieldSummary[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== "object") {
      fields.push({ name, type: "any", required: required.has(name) });
      continue;
    }
    const field = raw as Record<string, unknown>;
    const t = field.type;
    let type = "any";
    if (typeof t === "string") {
      type = t;
    } else if (Array.isArray(t)) {
      type = t.filter((x) => typeof x === "string").join("|") || "any";
    }
    fields.push({
      name,
      type,
      required: required.has(name),
      description:
        typeof field.description === "string" ? field.description : undefined,
    });
  }
  return fields;
}

function readServerId(tool: AnyTool): string | null {
  if (typeof tool._serverId === "string" && tool._serverId.length > 0) {
    return tool._serverId;
  }
  if (tool._meta && typeof tool._meta === "object") {
    const meta = tool._meta as Record<string, unknown>;
    if (typeof meta._serverId === "string" && meta._serverId.length > 0) {
      return meta._serverId;
    }
  }
  return null;
}

function readOriginalName(tool: AnyTool, modelName: string): string {
  if (typeof tool._originalName === "string" && tool._originalName.length > 0) {
    return tool._originalName;
  }
  return modelName;
}

/**
 * Build a catalog entry per tool in the ToolSet. Meta-tools (search/load) are
 * excluded — they are framework affordances, not searchable tools.
 */
export function buildToolCatalog(tools: ToolSet): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [];
  for (const [modelName, raw] of Object.entries(tools)) {
    if (!raw) continue;
    if (META_TOOL_NAMES.includes(modelName)) continue;
    const tool = raw as AnyTool;
    const serverId = readServerId(tool);
    const originalName = readOriginalName(tool, modelName);
    const inputSchema = readJsonSchema(tool.parameters ?? tool.inputSchema);
    const description =
      typeof tool.description === "string" ? tool.description : undefined;
    const fields = summarizeFields(inputSchema);
    const tokenEstimate = estimateEntryTokens({
      modelName,
      description,
      inputSchema,
    });
    const toolId = serverId
      ? `${serverId}::${originalName}`
      : `local::${modelName}`;
    entries.push({
      toolId,
      modelName,
      serverId,
      originalName,
      description,
      fields,
      inputSchema,
      tokenEstimate,
    });
  }
  return entries;
}

export function sumCatalogTokens(catalog: ToolCatalogEntry[]): number {
  let total = 0;
  for (const entry of catalog) total += entry.tokenEstimate;
  return total;
}

// ---------------------------------------------------------------------------
// Policy decision
// ---------------------------------------------------------------------------

export interface DecidePlanInput {
  catalog: ToolCatalogEntry[];
  modelContextLength?: number;
  options?: ProgressiveDiscoveryOptions;
  /** Hard override from env / explicit caller toggle. */
  envOverride?: ProgressiveDiscoveryEnabled;
}

export function decideProgressivePlan(
  input: DecidePlanInput,
): ProgressiveToolPlan {
  const policy = resolveDiscoveryPolicy(input.options);
  const totalTokenEstimate = sumCatalogTokens(input.catalog);
  const reasons: string[] = [];

  // Resolve the enabled mode. Env override beats caller option.
  const requested: ProgressiveDiscoveryEnabled =
    input.envOverride ?? input.options?.enabled ?? "auto";

  if (requested === false) {
    return {
      enabled: false,
      reasons: ["forced_off"],
      policy,
      catalog: input.catalog,
      totalTokenEstimate,
    };
  }

  if (requested === true) {
    return {
      enabled: true,
      reasons: ["forced_on"],
      policy,
      catalog: input.catalog,
      totalTokenEstimate,
    };
  }

  // Auto: trip on any of the three thresholds.
  let trip = false;
  if (input.catalog.length >= policy.maxToolCount) {
    trip = true;
    reasons.push(`tool_count>=${policy.maxToolCount}`);
  }
  if (totalTokenEstimate >= policy.maxToolTokens) {
    trip = true;
    reasons.push(`tool_tokens>=${policy.maxToolTokens}`);
  }
  if (
    typeof input.modelContextLength === "number" &&
    input.modelContextLength > 0
  ) {
    const ratio = totalTokenEstimate / input.modelContextLength;
    if (ratio >= policy.thresholdPct) {
      trip = true;
      reasons.push(`ctx_ratio>=${policy.thresholdPct}`);
    }
  }

  return {
    enabled: trip,
    reasons: trip ? reasons : ["below_thresholds"],
    policy,
    catalog: input.catalog,
    totalTokenEstimate,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const TOKEN_RE = /[A-Za-z0-9]+/g;

function tokenizeForSearch(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const matched = text.match(TOKEN_RE);
  if (!matched) return out;
  for (const tok of matched) {
    const lower = tok.toLowerCase();
    if (lower.length === 0) continue;
    out.push(lower);
  }
  return out;
}

interface RankedEntry {
  entry: ToolCatalogEntry;
  score: number;
}

export interface SearchOptions {
  serverIds?: string[];
  limit?: number;
}

/**
 * Score a single entry against tokenized query terms. We weight by surface:
 * tool name (model + original) >> description >> field names. A query term is
 * counted at most once per surface to avoid spammy descriptions dominating.
 */
function scoreEntry(entry: ToolCatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const nameTokens = new Set([
    ...tokenizeForSearch(entry.modelName),
    ...tokenizeForSearch(entry.originalName),
  ]);
  const descTokens = new Set(tokenizeForSearch(entry.description ?? ""));
  const fieldTokens = new Set<string>();
  for (const field of entry.fields) {
    for (const tok of tokenizeForSearch(field.name)) fieldTokens.add(tok);
    for (const tok of tokenizeForSearch(field.description ?? "")) {
      fieldTokens.add(tok);
    }
  }
  let score = 0;
  for (const term of terms) {
    if (nameTokens.has(term)) score += 3;
    else {
      // Substring fallback so "asana" matches "asana_create_task"-style names
      // even after tokenization splits on underscores (which it already does).
      // Kept cheap — only triggers when the exact token miss.
      for (const tok of nameTokens) {
        if (tok.includes(term)) {
          score += 2;
          break;
        }
      }
    }
    if (descTokens.has(term)) score += 1;
    if (fieldTokens.has(term)) score += 1;
  }
  return score;
}

export function searchToolCatalog(
  catalog: ToolCatalogEntry[],
  query: string,
  opts: SearchOptions = {},
): ToolCatalogEntry[] {
  const serverFilter =
    opts.serverIds && opts.serverIds.length > 0
      ? new Set(opts.serverIds)
      : undefined;
  const limit =
    typeof opts.limit === "number" && opts.limit > 0
      ? Math.floor(opts.limit)
      : DEFAULT_TOOL_DISCOVERY_POLICY.searchLimit;
  const terms = Array.from(new Set(tokenizeForSearch(query)));

  const filtered = serverFilter
    ? catalog.filter((e) => e.serverId !== null && serverFilter.has(e.serverId))
    : catalog;

  // Empty query: return first N entries, deterministic order (catalog order).
  if (terms.length === 0) {
    return filtered.slice(0, limit);
  }

  const ranked: RankedEntry[] = [];
  for (const entry of filtered) {
    const score = scoreEntry(entry, terms);
    if (score > 0) ranked.push({ entry, score });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.modelName.localeCompare(b.entry.modelName);
  });
  return ranked.slice(0, limit).map((r) => r.entry);
}

// ---------------------------------------------------------------------------
// Formatting for the model
// ---------------------------------------------------------------------------

/**
 * Concise per-match summary the model sees inside search_mcp_tools results.
 * Deliberately omits the full schema so the cost of a search is low; the
 * model loads the heavy descriptor only via load_mcp_tools.
 */
export interface ToolSearchMatch {
  toolId: string;
  name: string;
  serverId: string | null;
  description?: string;
  fields: { name: string; type: string; required: boolean }[];
}

export function formatToolSearchMatch(entry: ToolCatalogEntry): ToolSearchMatch {
  return {
    toolId: entry.toolId,
    name: entry.modelName,
    serverId: entry.serverId,
    description: entry.description,
    fields: entry.fields.map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
    })),
  };
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

export function createDiscoveryState(): ToolDiscoveryState {
  return {
    loadedToolIds: new Set(),
    newlyLoadedToolIds: new Set(),
    pendingApprovalToolIds: new Set(),
  };
}

/**
 * Map model-facing tool names (as carried on messages) to catalog tool ids.
 * Used to mark inherited / pending approval tools as exposed on resumption.
 */
export function lookupToolIdByModelName(
  catalog: ToolCatalogEntry[],
  modelName: string,
): string | undefined {
  for (const entry of catalog) {
    if (entry.modelName === modelName) return entry.toolId;
  }
  return undefined;
}

/**
 * Resolve which model-facing tool names should be exposed for the next step.
 *
 * In progressive mode this is:
 *   meta-tools (always) ∪ loaded ∪ pending-approval ∪ newly-loaded
 *
 * The "newly loaded" set is folded into "loaded" once consumed.
 */
export function resolveActiveToolNames(
  plan: ProgressiveToolPlan,
  state: ToolDiscoveryState,
  metaToolNames: readonly string[] = META_TOOL_NAMES,
): string[] {
  if (!plan.enabled) {
    // Non-progressive mode never advertises meta-tools — the orchestrator
    // omits them from the toolset entirely. Returning their names here
    // would only produce dead noise downstream (lookups that miss).
    return plan.catalog.map((e) => e.modelName);
  }
  const byId = new Map<string, ToolCatalogEntry>();
  for (const entry of plan.catalog) byId.set(entry.toolId, entry);
  const names = new Set<string>(metaToolNames);
  for (const id of state.loadedToolIds) {
    const entry = byId.get(id);
    if (entry) names.add(entry.modelName);
  }
  for (const id of state.newlyLoadedToolIds) {
    const entry = byId.get(id);
    if (entry) names.add(entry.modelName);
  }
  for (const id of state.pendingApprovalToolIds) {
    const entry = byId.get(id);
    if (entry) names.add(entry.modelName);
  }
  return [...names];
}

export function shouldForceInitialToolSearch(
  plan: ProgressiveToolPlan | undefined,
  state: ToolDiscoveryState | undefined,
  stepIndex: number,
): boolean {
  return (
    plan?.enabled === true &&
    state !== undefined &&
    stepIndex === 0 &&
    state.loadedToolIds.size === 0 &&
    state.newlyLoadedToolIds.size === 0 &&
    state.pendingApprovalToolIds.size === 0
  );
}

/**
 * Wrap a tools map so that out-of-subset tools throw a structured "not
 * loaded" error when invoked, while in-subset tools (meta-tools, loaded,
 * pending, newly-loaded) execute normally. In non-progressive mode this
 * returns the input map unchanged.
 *
 * The `resolveActiveToolNames` step already narrows what the model SEES
 * (either via `activeTools` in streamText, or by sending only the subset
 * to a server-side LLM). This is a defense-in-depth gate at the
 * execution layer: it catches remembered/hallucinated calls to tools the
 * model used in a prior turn but that are no longer in the active
 * subset. Throwing here funnels through the AI SDK's / executor's
 * per-tool catch and produces an error tool-result that points the model
 * back at `load_mcp_tools`, keeping the turn alive instead of running an
 * ungated tool.
 *
 * The state is read at execute-time via the supplied accessor so the gate
 * sees the latest loaded/newly-loaded set across multi-step turns (the
 * AI SDK's `tools` option is set once but state mutates between steps).
 */
export function gateToolsToActiveSubset<T extends Record<string, unknown>>(
  tools: T,
  plan: ProgressiveToolPlan | undefined,
  getState: () => ToolDiscoveryState | undefined,
): T {
  if (!plan?.enabled) return tools;
  // Only tools the plan actually catalogs are subject to lazy loading. Tools
  // outside the catalog — meta-tools, or tools injected into the map after the
  // catalog was built (e.g. the eval Computer Use tools) — can't be activated
  // via load_mcp_tools (they have no catalog toolId), so gating them here would
  // make them permanently uncallable. They're always executable; any per-step
  // visibility gating happens in the advertised-subset layer instead.
  const catalogNames = new Set(plan.catalog.map((entry) => entry.modelName));
  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(tools)) {
    const original = def as Record<string, unknown>;
    const execute = original.execute as
      | ((input: unknown, ctx: unknown) => unknown)
      | undefined;
    if (!execute) {
      result[name] = original;
      continue;
    }
    result[name] = {
      ...original,
      execute: async (input: unknown, ctx: unknown) => {
        const state = getState();
        if (state && catalogNames.has(name)) {
          const activeNames = new Set(resolveActiveToolNames(plan, state));
          if (!activeNames.has(name)) {
            const toolId = lookupToolIdByModelName(plan.catalog, name);
            const hint = toolId
              ? `Call load_mcp_tools with toolIds=[${JSON.stringify(toolId)}] first, then retry.`
              : `Call search_mcp_tools to find the matching tool id, then load_mcp_tools to activate it.`;
            throw new Error(
              `Tool '${name}' is not loaded in this step. ${hint}`,
            );
          }
        }
        return execute(input, ctx);
      },
    };
  }
  return result as T;
}

/**
 * Hydrate `state.loadedToolIds` from `load_mcp_tools` calls in a prior
 * message history. Without this, every new request starts from an empty
 * loaded set and a multi-turn flow that depended on a previously loaded
 * tool would regress to meta-tools only — the model's history references
 * a tool the orchestrator no longer considers "loaded".
 *
 * We read directly from the tool-call inputs (toolIds) rather than the
 * tool-result payloads. The input is the model's intent; using it means
 * tools the model attempted to load are restored even if a prior result
 * was an error or got scrubbed. Ids absent from the current catalog are
 * dropped silently (the server may have disconnected since).
 */
export function hydrateDiscoveryStateFromHistory(
  state: ToolDiscoveryState,
  messages: ReadonlyArray<unknown>,
  catalog: ReadonlyArray<ToolCatalogEntry>,
): number {
  const knownIds = new Set(catalog.map((entry) => entry.toolId));
  let added = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partType = (part as { type?: unknown }).type;
      if (partType !== "tool-call") continue;
      const toolName = (part as { toolName?: unknown }).toolName;
      if (toolName !== META_TOOL_LOAD) continue;
      const input = (part as { input?: unknown; args?: unknown }).input
        ?? (part as { args?: unknown }).args;
      if (!input || typeof input !== "object") continue;
      const ids = (input as { toolIds?: unknown }).toolIds;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id !== "string") continue;
        if (!knownIds.has(id)) continue;
        if (state.loadedToolIds.has(id)) continue;
        state.loadedToolIds.add(id);
        added += 1;
      }
    }
  }
  return added;
}

/**
 * Move newly-loaded tool ids into the persistent loaded set after a step has
 * been built. Returns the count of ids promoted.
 */
export function commitNewlyLoaded(state: ToolDiscoveryState): number {
  let promoted = 0;
  for (const id of state.newlyLoadedToolIds) {
    if (!state.loadedToolIds.has(id)) {
      state.loadedToolIds.add(id);
      promoted += 1;
    }
  }
  state.newlyLoadedToolIds.clear();
  return promoted;
}
