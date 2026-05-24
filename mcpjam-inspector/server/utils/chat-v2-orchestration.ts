/**
 * Shared chat-v2 tool preparation and message scrubbing.
 *
 * Encapsulates the identical prep logic used by both mcp/chat-v2 and web/chat-v2:
 *   1. getToolsForAiSdk + getSkillToolsAndPrompt + needsApproval merge
 *   2. Anthropic tool name validation (throws on invalid names)
 *   3. System prompt + skills prompt concatenation
 *   4. Temperature resolution (GPT-5 check)
 *   5. scrubMessages lambda construction
 *
 * Intentionally NOT shared:
 *   - Model type check (isMCPJamProvidedModel) — web rejects non-MCPJam; mcp supports user-provided
 *   - Error shape — web throws WebRouteError; mcp returns c.json()
 *   - Manager lifecycle — web has onStreamComplete cleanup; mcp uses singleton
 *   - streamText path — only in mcp
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { jsonSchema, tool, type ToolSet } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import { isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  isAnthropicCompatibleModel,
  getInvalidAnthropicToolNames,
  scrubUnavailableToolHistoryForBackend,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
  type CustomProviderConfig,
} from "./chat-helpers.js";
import { getSkillToolsAndPrompt } from "./skill-tools.js";
import { isGPT5Model, type ModelDefinition } from "@/shared/types";
import { HOSTED_MODE } from "../config.js";
import {
  buildToolCatalog,
  createDiscoveryState,
  decideProgressivePlan,
  hydrateDiscoveryStateFromHistory,
  META_TOOL_NAMES,
  parseProgressiveToolsEnv,
  type ProgressiveDiscoveryOptions,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import { createProgressiveMetaTools } from "./progressive-tool-meta-tools.js";

const DEFAULT_TEMPERATURE = 0.7;

/**
 * Mutates `tools` in place, removing entries whose source MCP tool
 * declares SEP-1865 `_meta.ui.visibility` as exactly `["app"]`.
 *
 * The visibility array defaults to `["model", "app"]` per SEP-1865, so a
 * tool with no visibility metadata is treated as visible to both.
 */
function filterAppOnlyTools(
  tools: ToolSet,
  manager: InstanceType<typeof MCPClientManager>,
): void {
  // Cache per-server metadata maps so we don't repeatedly clone them.
  const metaByServer = new Map<string, Record<string, Record<string, any>>>();
  const getMeta = (serverId: string) => {
    let cached = metaByServer.get(serverId);
    if (!cached) {
      cached = manager.getAllToolsMetadata(serverId);
      metaByServer.set(serverId, cached);
    }
    return cached;
  };

  for (const [name, tool] of Object.entries(tools)) {
    const serverId = (tool as { _serverId?: unknown })._serverId;
    if (typeof serverId !== "string") continue;
    const meta = getMeta(serverId)[name];
    // SDK helper takes a tool-shaped object with `_meta`; wrap the per-tool
    // metadata to match its expected shape. Returns true iff `_meta.ui.visibility`
    // is exactly `["app"]`.
    if (isToolVisibilityAppOnly({ _meta: meta })) {
      delete tools[name];
    }
  }
}

/**
 * SEP-1865 App-Provided Tool descriptor as accepted by `prepareChatV2`,
 * already sanitized by {@link validateAppToolEntries}.
 *
 * Mirrors `AppToolSnapshotEntry` in `shared/chat-v2.ts` (single source
 * of truth for the wire shape). `rawName` is preserved for logging only;
 * the model-facing tool name is always `alias` (opaque, ≤14 chars,
 * validated against `/^app_[a-z0-9]{8}$/i`).
 */
export type AppToolEntry = import("@/shared/chat-v2").AppToolSnapshotEntry;

// Caps mirror the client snapshotter at
// `client/src/components/chat-v2/thread/mcp-apps/app-tools-registry.ts`.
// Validation is intentionally NOT done with Zod — this route doesn't use
// Zod elsewhere; adding it just for one field would introduce a new
// pattern. The plain-TS validator below matches the rest of the route's
// inline validation style.
const APP_TOOL_ALIAS_REGEX = /^app_[a-z0-9]{8}$/i;
const APP_TOOL_MAX_ENTRIES = 64;
const APP_TOOL_MAX_NAME_CHARS = 128;
const APP_TOOL_MAX_DESCRIPTION_CHARS = 512;
const APP_TOOL_MAX_INPUT_SCHEMA_BYTES = 8 * 1024;

export class AppToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppToolValidationError";
  }
}

/**
 * Validate and normalize the client-supplied `appTools` snapshot.
 *
 * Returns a cleaned array of {@link AppToolEntry} or throws
 * {@link AppToolValidationError} — routes turn the throw into a 400.
 *
 * Defensive duplicates of the client snapshotter's limits: nothing here
 * trusts the client to have enforced them. Oversized `inputSchema` is
 * rejected (not truncated mid-schema) so the resulting JSON Schema is
 * always semantically valid.
 */
export function validateAppToolEntries(input: unknown): AppToolEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new AppToolValidationError("appTools must be an array");
  }
  if (input.length > APP_TOOL_MAX_ENTRIES) {
    throw new AppToolValidationError(
      `appTools accepts at most ${APP_TOOL_MAX_ENTRIES} entries, got ${input.length}`,
    );
  }
  const out: AppToolEntry[] = [];
  const seenAliases = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") {
      throw new AppToolValidationError(`appTools[${i}] must be an object`);
    }
    const alias = raw.alias;
    if (typeof alias !== "string" || !APP_TOOL_ALIAS_REGEX.test(alias)) {
      throw new AppToolValidationError(
        `appTools[${i}].alias must match ${APP_TOOL_ALIAS_REGEX}`,
      );
    }
    if (seenAliases.has(alias)) {
      throw new AppToolValidationError(
        `appTools[${i}].alias '${alias}' is duplicated`,
      );
    }
    seenAliases.add(alias);
    const checkName = (
      key: "appName" | "rawName" | "serverId" | "parentToolCallId",
    ) => {
      const v = raw[key];
      if (
        typeof v !== "string" ||
        v.length === 0 ||
        v.length > APP_TOOL_MAX_NAME_CHARS
      ) {
        throw new AppToolValidationError(
          `appTools[${i}].${key} must be a non-empty string ≤${APP_TOOL_MAX_NAME_CHARS} chars`,
        );
      }
      return v;
    };
    const appName = checkName("appName");
    const rawName = checkName("rawName");
    const serverId = checkName("serverId");
    const parentToolCallId = checkName("parentToolCallId");
    if (raw.appVersion !== undefined && typeof raw.appVersion !== "string") {
      throw new AppToolValidationError(
        `appTools[${i}].appVersion must be a string`,
      );
    }
    const appVersion = raw.appVersion as string | undefined;
    let description: string | undefined;
    if (raw.description !== undefined) {
      if (typeof raw.description !== "string") {
        throw new AppToolValidationError(
          `appTools[${i}].description must be a string`,
        );
      }
      if (raw.description.length > APP_TOOL_MAX_DESCRIPTION_CHARS) {
        throw new AppToolValidationError(
          `appTools[${i}].description exceeds ${APP_TOOL_MAX_DESCRIPTION_CHARS} chars`,
        );
      }
      description = raw.description;
    }
    let inputSchema: Record<string, unknown> | undefined;
    if (raw.inputSchema !== undefined) {
      if (
        raw.inputSchema === null ||
        typeof raw.inputSchema !== "object" ||
        Array.isArray(raw.inputSchema)
      ) {
        throw new AppToolValidationError(
          `appTools[${i}].inputSchema must be a JSON object`,
        );
      }
      let size = 0;
      try {
        size = new TextEncoder().encode(
          JSON.stringify(raw.inputSchema),
        ).length;
      } catch {
        throw new AppToolValidationError(
          `appTools[${i}].inputSchema is not JSON-serializable`,
        );
      }
      if (size > APP_TOOL_MAX_INPUT_SCHEMA_BYTES) {
        throw new AppToolValidationError(
          `appTools[${i}].inputSchema exceeds ${APP_TOOL_MAX_INPUT_SCHEMA_BYTES} bytes`,
        );
      }
      inputSchema = raw.inputSchema as Record<string, unknown>;
    }
    if (typeof raw.readOnly !== "boolean") {
      throw new AppToolValidationError(
        `appTools[${i}].readOnly must be a boolean`,
      );
    }
    out.push({
      alias,
      appName,
      appVersion,
      serverId,
      parentToolCallId,
      rawName,
      description,
      inputSchema,
      readOnly: raw.readOnly,
    });
  }
  return out;
}

export interface PrepareChatV2Options {
  mcpClientManager: InstanceType<typeof MCPClientManager>;
  selectedServers?: string[];
  modelDefinition: ModelDefinition;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  customProviders?: CustomProviderConfig[];
  /** Progressive discovery overrides (e.g. tighter thresholds for tests). */
  progressiveToolDiscovery?: ProgressiveDiscoveryOptions;
  /**
   * Prior conversation messages, used to hydrate progressive discovery
   * state across turns. Without these, `discoveryState.loadedToolIds`
   * resets every request and any tools the model loaded earlier in the
   * session disappear — multi-turn flows regress to meta-tools only.
   */
  priorMessages?: ReadonlyArray<ModelMessage>;
  appTools?: AppToolEntry[];
}

/**
 * Build no-execute AI SDK tool entries from the client snapshot.
 *
 * No `execute` is set on purpose: `streamText` will stream the tool-call to
 * the client, where `useChat.onToolCall` dispatches into the right iframe
 * via `AppBridge.callTool` and supplies the result back via `addToolOutput`.
 *
 * All app-provided tools are emitted. `readOnly` is preserved in the snapshot
 * for policy/telemetry, but MCPJam does not force approval for app-provided
 * tools here; normal server-tool approval remains scoped to server tools.
 */
export function buildAppTools(appTools: AppToolEntry[] | undefined): ToolSet {
  if (!appTools || appTools.length === 0) return {};
  const out: ToolSet = {};
  for (const t of appTools) {
    out[t.alias] = tool({
      description: `[${t.appName}] ${t.description ?? t.rawName}`,
      inputSchema: jsonSchema(
        (t.inputSchema as Parameters<typeof jsonSchema>[0]) ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      ),
      // No execute — client fulfills via onToolCall.
    });
  }
  return out;
}

export interface PrepareChatV2Result {
  allTools: ToolSet;
  enhancedSystemPrompt: string;
  resolvedTemperature: number | undefined;
  scrubMessages: (msgs: ModelMessage[]) => ModelMessage[];
  /**
   * Per-turn progressive discovery context. `plan.enabled === false` means
   * downstream code should behave exactly as before. When enabled, the
   * orchestrator uses `discoveryState` to compute active tool subsets per
   * step and the meta-tools (already merged into `allTools`) bridge the gap.
   */
  progressivePlan: ProgressiveToolPlan;
  discoveryState: ToolDiscoveryState;
}

/**
 * Prepare tools, system prompt, temperature, and message scrubber for chat-v2.
 *
 * Throws if Anthropic tool name validation fails.
 */
export async function prepareChatV2(
  options: PrepareChatV2Options,
): Promise<PrepareChatV2Result> {
  const {
    mcpClientManager,
    selectedServers,
    modelDefinition,
    systemPrompt,
    temperature,
    requireToolApproval,
    customProviders,
    appTools,
  } = options;

  // Drop ids the manager hasn't registered (server disabled/disconnected, or
  // a stale id baked into a chatbox config). Passing them through reaches
  // ensureConnected and throws "Unknown MCP server", 500-ing the whole chat.
  const knownSelectedServers = selectedServers?.filter((id) =>
    mcpClientManager.hasServer(id),
  );

  // 1. Get MCP + skill tools
  const mcpTools = await mcpClientManager.getToolsForAiSdk(
    knownSelectedServers,
    requireToolApproval ? { needsApproval: requireToolApproval } : undefined,
  );

  // SEP-1865: tools whose `_meta.ui.visibility` is exactly `["app"]` are
  // hidden from the model — they remain callable from the iframe via the
  // bridge but must not appear in the AI SDK tool set. The conversion
  // helper doesn't lift `_meta` onto the AiSdkTool, so we look the
  // metadata back up per (serverId, toolName) from the manager's cache.
  filterAppOnlyTools(mcpTools, mcpClientManager);
  const { tools: skillTools, systemPromptSection: skillsPromptSection } =
    HOSTED_MODE
      ? { tools: {}, systemPromptSection: "" }
      : await getSkillToolsAndPrompt();

  const finalSkillTools: Record<string, unknown> = requireToolApproval
    ? Object.fromEntries(
        Object.entries(skillTools).map(([name, tool]) => [
          name,
          {
            ...(tool && typeof tool === "object" ? tool : {}),
            needsApproval: true,
          },
        ]),
      )
    : (skillTools as Record<string, unknown>);

  // SEP-1865 App-Provided Tools (Host → App direction). Client supplies
  // the snapshot per chat POST; we register them as no-execute entries so
  // streamText streams the tool-call back to the client for in-iframe
  // dispatch via `AppBridge.callTool`. Merged after server tools and
  // before skills so an app alias never collides with either (the
  // `app_<8hex>` namespace is opaque and disjoint from both).
  const appToolEntries = buildAppTools(appTools);
  const realTools = {
    ...mcpTools,
    ...appToolEntries,
    ...finalSkillTools,
  } as ToolSet;

  // 2. Decide whether progressive discovery applies, then mint meta-tools if
  // it does. The catalog is built from real tools only (meta-tools aren't
  // searchable) but the meta-tools are then merged into the final ToolSet so
  // both streamText and the Convex loop see them.
  const catalog = buildToolCatalog(realTools);
  const discoveryState = createDiscoveryState();
  // Replay prior `load_mcp_tools` calls into the discovery state before
  // we mint the plan / meta-tools. Without hydration, a multi-turn
  // session would forget every tool it loaded — even though the
  // conversation history still references those tools — and the next
  // step would only show meta-tools. See
  // `hydrateDiscoveryStateFromHistory` for replay semantics.
  if (options.priorMessages && options.priorMessages.length > 0) {
    hydrateDiscoveryStateFromHistory(
      discoveryState,
      options.priorMessages,
      catalog,
    );
  }
  const envOverride = parseProgressiveToolsEnv(
    process.env.MCPJAM_PROGRESSIVE_TOOLS,
  );
  const progressivePlan = decideProgressivePlan({
    catalog,
    modelContextLength: modelDefinition.contextLength,
    options: options.progressiveToolDiscovery,
    envOverride,
  });

  const metaTools: ToolSet = progressivePlan.enabled
    ? createProgressiveMetaTools({
        getCatalog: () => catalog,
        state: discoveryState,
        policy: progressivePlan.policy,
      })
    : {};

  const allTools = { ...realTools, ...metaTools } as ToolSet;
  const availableToolNames = Object.keys(allTools);

  // 3. Anthropic tool name validation — meta-tool names are conforming and
  // checked alongside real tools.
  if (isAnthropicCompatibleModel(modelDefinition, customProviders)) {
    const invalidNames = getInvalidAnthropicToolNames(Object.keys(allTools));
    if (invalidNames.length > 0) {
      const nameList = invalidNames.map((name) => `'${name}'`).join(", ");
      throw new Error(
        `Invalid tool name(s) for Anthropic: ${nameList}. Tool names must only contain letters, numbers, underscores, and hyphens (max 64 characters).`,
      );
    }
  }
  // Guard: meta-tool name must never collide with a real tool. If it does,
  // fail fast — the catalog filter excludes them but a real MCP server
  // exposing a tool literally named "search_mcp_tools" would silently
  // shadow the meta-tool and break discovery.
  if (progressivePlan.enabled) {
    for (const name of META_TOOL_NAMES) {
      // realTools is the pre-meta-merge map; collision means an MCP/skill
      // tool already claimed the name.
      if (Object.prototype.hasOwnProperty.call(realTools, name)) {
        throw new Error(
          `MCP tool '${name}' collides with the progressive-discovery meta-tool of the same name. Rename the MCP tool or set MCPJAM_PROGRESSIVE_TOOLS=off.`,
        );
      }
    }
  }

  // 3. System prompt concatenation
  const enhancedSystemPrompt = [systemPrompt, skillsPromptSection]
    .filter((section): section is string => Boolean(section?.trim()))
    .map((section) => section.trim())
    .join("\n\n");

  // 4. Temperature resolution
  const resolvedTemperature = isGPT5Model(modelDefinition.id)
    ? undefined
    : (temperature ?? DEFAULT_TEMPERATURE);

  // 5. Message scrubber
  const scrubMessages = (msgs: ModelMessage[]) =>
    scrubChatGPTAppsToolResultsForBackend(
      scrubMcpAppsToolResultsForBackend(
        scrubUnavailableToolHistoryForBackend(msgs, availableToolNames),
        mcpClientManager,
        knownSelectedServers,
      ),
      mcpClientManager,
      knownSelectedServers,
    );

  return {
    allTools,
    enhancedSystemPrompt,
    resolvedTemperature,
    scrubMessages,
    progressivePlan,
    discoveryState,
  };
}
