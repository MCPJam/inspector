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
import {
  filterAppOnlyTools,
  type ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import {
  isAnthropicCompatibleModel,
  getInvalidAnthropicToolNames,
  scrubUnavailableToolHistoryForBackend,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
  type CustomProviderConfig,
} from "./chat-helpers.js";
import { getSkillToolsAndPrompt } from "./skill-tools.js";
import { getCloudSkillToolsAndPrompt } from "./computers/cloud-skill-tools.js";
import { logger } from "./logger.js";
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

// `filterAppOnlyTools` now lives in `@mcpjam/sdk/host-config/internal` so the
// eval runtime can apply it without reaching into this file. Re-exported here
// so existing importers (web/mcp routes, tests) continue to work without
// churning their import paths.
export { filterAppOnlyTools };

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
export type WidgetModelContextEntry =
  import("@/shared/chat-v2").WidgetModelContextEntry;

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
const WIDGET_MODEL_CONTEXT_MAX_ENTRIES = 32;
const WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS = 32;
const WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES = 64 * 1024;

export class AppToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppToolValidationError";
  }
}

export class WidgetModelContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetModelContextValidationError";
  }
}

function assertJsonByteSize(
  value: unknown,
  label: string,
  maxBytes: number
): void {
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    throw new WidgetModelContextValidationError(
      `${label} is not JSON-serializable`
    );
  }
  if (size > maxBytes) {
    throw new WidgetModelContextValidationError(
      `${label} exceeds ${maxBytes} bytes`
    );
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
      `appTools accepts at most ${APP_TOOL_MAX_ENTRIES} entries, got ${input.length}`
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
        `appTools[${i}].alias must match ${APP_TOOL_ALIAS_REGEX}`
      );
    }
    if (seenAliases.has(alias)) {
      throw new AppToolValidationError(
        `appTools[${i}].alias '${alias}' is duplicated`
      );
    }
    seenAliases.add(alias);
    const checkName = (
      key: "appName" | "rawName" | "serverId" | "parentToolCallId"
    ) => {
      const v = raw[key];
      if (
        typeof v !== "string" ||
        v.length === 0 ||
        v.length > APP_TOOL_MAX_NAME_CHARS
      ) {
        throw new AppToolValidationError(
          `appTools[${i}].${key} must be a non-empty string ≤${APP_TOOL_MAX_NAME_CHARS} chars`
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
        `appTools[${i}].appVersion must be a string`
      );
    }
    const appVersion = raw.appVersion as string | undefined;
    let description: string | undefined;
    if (raw.description !== undefined) {
      if (typeof raw.description !== "string") {
        throw new AppToolValidationError(
          `appTools[${i}].description must be a string`
        );
      }
      if (raw.description.length > APP_TOOL_MAX_DESCRIPTION_CHARS) {
        throw new AppToolValidationError(
          `appTools[${i}].description exceeds ${APP_TOOL_MAX_DESCRIPTION_CHARS} chars`
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
          `appTools[${i}].inputSchema must be a JSON object`
        );
      }
      let size = 0;
      try {
        size = new TextEncoder().encode(JSON.stringify(raw.inputSchema)).length;
      } catch {
        throw new AppToolValidationError(
          `appTools[${i}].inputSchema is not JSON-serializable`
        );
      }
      if (size > APP_TOOL_MAX_INPUT_SCHEMA_BYTES) {
        throw new AppToolValidationError(
          `appTools[${i}].inputSchema exceeds ${APP_TOOL_MAX_INPUT_SCHEMA_BYTES} bytes`
        );
      }
      inputSchema = raw.inputSchema as Record<string, unknown>;
    }
    if (typeof raw.readOnly !== "boolean") {
      throw new AppToolValidationError(
        `appTools[${i}].readOnly must be a boolean`
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

export function validateWidgetModelContextEntries(
  input: unknown
): WidgetModelContextEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new WidgetModelContextValidationError(
      "widgetModelContext must be an array"
    );
  }
  if (input.length > WIDGET_MODEL_CONTEXT_MAX_ENTRIES) {
    throw new WidgetModelContextValidationError(
      `widgetModelContext accepts at most ${WIDGET_MODEL_CONTEXT_MAX_ENTRIES} entries, got ${input.length}`
    );
  }

  return input.map((entry, i): WidgetModelContextEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WidgetModelContextValidationError(
        `widgetModelContext[${i}] must be an object`
      );
    }
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.toolCallId !== "string" ||
      raw.toolCallId.length === 0 ||
      raw.toolCallId.length > APP_TOOL_MAX_NAME_CHARS
    ) {
      throw new WidgetModelContextValidationError(
        `widgetModelContext[${i}].toolCallId must be a non-empty string ≤${APP_TOOL_MAX_NAME_CHARS} chars`
      );
    }
    if (
      !raw.context ||
      typeof raw.context !== "object" ||
      Array.isArray(raw.context)
    ) {
      throw new WidgetModelContextValidationError(
        `widgetModelContext[${i}].context must be an object`
      );
    }

    const context = raw.context as Record<string, unknown>;
    const out: WidgetModelContextEntry = {
      toolCallId: raw.toolCallId,
      context: {},
    };

    if (context.content !== undefined) {
      if (!Array.isArray(context.content)) {
        throw new WidgetModelContextValidationError(
          `widgetModelContext[${i}].context.content must be an array`
        );
      }
      if (context.content.length > WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS) {
        throw new WidgetModelContextValidationError(
          `widgetModelContext[${i}].context.content accepts at most ${WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS} blocks`
        );
      }
      for (let j = 0; j < context.content.length; j++) {
        const block = context.content[j];
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          throw new WidgetModelContextValidationError(
            `widgetModelContext[${i}].context.content[${j}] must be an object`
          );
        }
      }
      assertJsonByteSize(
        context.content,
        `widgetModelContext[${i}].context.content`,
        WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES
      );
      out.context.content = context.content as Record<string, unknown>[];
    }

    if (context.structuredContent !== undefined) {
      if (
        !context.structuredContent ||
        typeof context.structuredContent !== "object" ||
        Array.isArray(context.structuredContent)
      ) {
        throw new WidgetModelContextValidationError(
          `widgetModelContext[${i}].context.structuredContent must be an object`
        );
      }
      assertJsonByteSize(
        context.structuredContent,
        `widgetModelContext[${i}].context.structuredContent`,
        WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES
      );
      out.context.structuredContent = context.structuredContent as Record<
        string,
        unknown
      >;
    }

    return out;
  });
}

function renderWidgetContextContentBlock(
  block: Record<string, unknown>
): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string"
        ? block.text
        : JSON.stringify(block);
    case "image":
      return `[image: ${
        typeof block.mimeType === "string" ? block.mimeType : "unknown type"
      }]`;
    case "audio":
      return `[audio: ${
        typeof block.mimeType === "string" ? block.mimeType : "unknown type"
      }]`;
    case "resource_link": {
      const name = typeof block.name === "string" ? block.name : "resource";
      const uri = typeof block.uri === "string" ? block.uri : "unknown URI";
      return `Resource link: ${name} (${uri})`;
    }
    case "resource": {
      const resource = block.resource;
      if (
        resource &&
        typeof resource === "object" &&
        !Array.isArray(resource)
      ) {
        const r = resource as Record<string, unknown>;
        if (typeof r.text === "string") {
          return `Embedded resource${
            typeof r.uri === "string" ? ` (${r.uri})` : ""
          }:\n${r.text}`;
        }
        if (typeof r.uri === "string") {
          return `Embedded resource: ${r.uri}`;
        }
      }
      return `Embedded resource: ${JSON.stringify(block)}`;
    }
    default:
      return JSON.stringify(block);
  }
}

export function buildWidgetModelContextSystemPrompt(
  entries: WidgetModelContextEntry[]
): string {
  if (entries.length === 0) return "";

  const sections = entries.map((entry) => {
    const lines = [`Widget context from tool call \`${entry.toolCallId}\`:`];
    const content = entry.context.content ?? [];
    if (content.length > 0) {
      lines.push(
        "Content:",
        ...content.map((block) => renderWidgetContextContentBlock(block))
      );
    }
    if (entry.context.structuredContent) {
      lines.push(
        "Structured content:",
        "```json",
        JSON.stringify(entry.context.structuredContent, null, 2),
        "```"
      );
    }
    return lines.join("\n");
  });

  return [
    "The MCP App widget sent the following `ui/update-model-context` state. Treat it as current app state for this turn, not as a new user request.",
    ...sections,
  ].join("\n\n");
}

/**
 * EVAL analogue of {@link buildWidgetModelContextSystemPrompt}: frame recorded
 * widget→host tool CALLS (triggered by `Interact` steps) as current app state so
 * a headless eval model reasons over a widget interaction on its next turn — the
 * server-side analogue of Playground's browser-only `addToolOutput` +
 * auto-continue, which can't run in the headless Node runner. Reuses the same
 * content-block renderer. Per SEP-1865 the tool result's `content` is what's
 * meant for model context (`structuredContent` is not), so we render `content`
 * only. Callers pass model-visible calls only (app-only `visibility:["app"]`
 * calls are UI-only and filtered upstream).
 */
export function buildWidgetInteractionContextSystemPrompt(
  calls: ReadonlyArray<{ toolName: string; result?: unknown }>
): string {
  if (calls.length === 0) return "";

  const sections = calls.map((call) => {
    const result = call.result as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    const content = result?.content ?? [];
    const lines = [
      `The user interacted with the \`${call.toolName}\` MCP App widget, which called the \`${call.toolName}\` tool. It returned:`,
    ];
    if (content.length > 0) {
      lines.push(
        ...content.map((block) => renderWidgetContextContentBlock(block))
      );
    } else {
      lines.push("(no textual content)");
    }
    return lines.join("\n");
  });

  return [
    "During this conversation the user performed interactions inside MCP App widgets. Each call below was triggered by a user action and executed against the server; treat the results as current app state for this turn, not as new user requests.",
    ...sections,
  ].join("\n\n");
}

export interface PrepareChatV2Options {
  mcpClientManager: InstanceType<typeof MCPClientManager>;
  selectedServers?: string[];
  modelDefinition: ModelDefinition;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  /**
   * Host-level switch for SEP-1865 `_meta.ui.visibility` filtering.
   * `undefined` or `true` filters app-only tools out of the model tool
   * set (spec default). Only an explicit `false` opts out — used by the
   * Cursor template to mirror hosts that don't yet implement visibility.
   */
  respectToolVisibility?: boolean;
  /** Host/client policy for eligible MCP tool-result content/resources. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
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
  /** Server-side built-in tools (e.g. web_search) with their own execute. */
  builtInTools?: ToolSet;
  /**
   * When set, skills are sourced from the caller's **Computer** (E2B sandbox)
   * instead of the local filesystem — the hosted/`/web` path. Only set by
   * callers whose host actually has a computer, so "advertise == enforce".
   * Takes precedence over the local/HOSTED_MODE skill branches.
   */
  cloudSkills?: { authHeader: string; projectId: string };
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
        }
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
  options: PrepareChatV2Options
): Promise<PrepareChatV2Result> {
  const {
    mcpClientManager,
    selectedServers,
    modelDefinition,
    systemPrompt,
    temperature,
    requireToolApproval,
    respectToolVisibility,
    modelVisibleMcpToolResults,
    customProviders,
    appTools,
    builtInTools,
    cloudSkills,
  } = options;

  // Drop ids the manager hasn't registered (server disabled/disconnected, or
  // a stale id baked into a chatbox config). Passing them through reaches
  // ensureConnected and throws "Unknown MCP server", 500-ing the whole chat.
  const knownSelectedServers = selectedServers?.filter((id) =>
    mcpClientManager.hasServer(id)
  );

  const toolOptions =
    requireToolApproval ||
    respectToolVisibility === false ||
    modelVisibleMcpToolResults !== undefined
      ? {
          ...(requireToolApproval
            ? { needsApproval: requireToolApproval }
            : {}),
          ...(respectToolVisibility === false ? { includeAppOnly: true } : {}),
          ...(modelVisibleMcpToolResults !== undefined
            ? { modelVisibleMcpToolResults }
            : {}),
        }
      : undefined;

  // 1. Get MCP + skill tools
  const mcpTools = await mcpClientManager.getToolsForAiSdk(
    knownSelectedServers,
    toolOptions
  );

  // SEP-1865: tools whose `_meta.ui.visibility` is exactly `["app"]` are
  // hidden from the model — they remain callable from the iframe via the
  // bridge but must not appear in the AI SDK tool set. When the host
  // explicitly opts out, include them in the SDK conversion above so this
  // gate remains the single policy switch.
  //
  // Gated by the host policy `respectToolVisibility`. `undefined` and
  // `true` both filter (spec default); only an explicit `false` opts
  // out — currently the Cursor template, which mirrors real Cursor's
  // lack of visibility filtering.
  if (respectToolVisibility !== false) {
    filterAppOnlyTools(mcpTools, mcpClientManager);
  }
  // Skills source, in precedence order:
  //   1. cloudSkills set ⇒ the caller's Computer (E2B sandbox) — hosted path
  //      with a provisioned computer. Lazy discovery (no upfront wake).
  //   2. HOSTED_MODE without a computer ⇒ no skills (local FS unavailable).
  //   3. local ⇒ the inspector's own filesystem.
  const { tools: skillTools, systemPromptSection: skillsPromptSection } =
    cloudSkills
      ? getCloudSkillToolsAndPrompt({
          authHeader: cloudSkills.authHeader,
          projectId: cloudSkills.projectId,
        })
      : HOSTED_MODE
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
        ])
      )
    : (skillTools as Record<string, unknown>);

  // SEP-1865 App-Provided Tools (Host → App direction). Client supplies
  // the snapshot per chat POST; we register them as no-execute entries so
  // streamText streams the tool-call back to the client for in-iframe
  // dispatch via `AppBridge.callTool`. Merged after server tools and
  // before skills so an app alias never collides with either (the
  // `app_<8hex>` namespace is opaque and disjoint from both).
  const appToolEntries = buildAppTools(appTools);
  const builtInToolEntries = builtInTools ?? {};
  // Collision policy, per origin:
  //  - MCP tools: the built-in wins and the server tool is dropped with a
  //    warn. Built-ins are the host's explicit catalog choice, and the
  //    expected collision is a genuine twin — the MCPJam remote MCP server
  //    exposes the same platform operations (list_project_servers, …) the
  //    workspace built-ins are made of. Failing the whole turn over a
  //    same-named server tool punishes the host for connecting MCPJam's own
  //    server.
  //  - App and skill tools: still fail closed. The `app_<8hex>` alias
  //    namespace and the curated skill set are disjoint from catalog ids by
  //    construction, so a collision there is a bug, not a configuration.
  for (const name of Object.keys(builtInToolEntries)) {
    if (Object.prototype.hasOwnProperty.call(mcpTools, name)) {
      logger.warn(
        `[chat-v2] built-in tool '${name}' shadows an MCP tool with the same name; using the built-in`
      );
      delete mcpTools[name];
    }
    if (
      Object.prototype.hasOwnProperty.call(appToolEntries, name) ||
      Object.prototype.hasOwnProperty.call(finalSkillTools, name)
    ) {
      throw new Error(
        `Built-in tool '${name}' collides with an existing app or skill tool.`
      );
    }
  }
  // Built-ins merge last so an explicit built-in wins; the policy above has
  // already resolved (or rejected) every collision by here.
  const realTools = {
    ...mcpTools,
    ...appToolEntries,
    ...finalSkillTools,
    ...builtInToolEntries,
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
      catalog
    );
  }
  const envOverride = parseProgressiveToolsEnv(
    process.env.MCPJAM_PROGRESSIVE_TOOLS
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
  // checked alongside real tools. Bedrock's Converse API enforces the same
  // ^[a-zA-Z0-9_-]{1,64}$ tool-name shape as Anthropic, so it shares the gate.
  if (
    isAnthropicCompatibleModel(modelDefinition, customProviders) ||
    modelDefinition.provider === "bedrock"
  ) {
    const invalidNames = getInvalidAnthropicToolNames(Object.keys(allTools));
    if (invalidNames.length > 0) {
      const nameList = invalidNames.map((name) => `'${name}'`).join(", ");
      const providerLabel =
        modelDefinition.provider === "bedrock" ? "Amazon Bedrock" : "Anthropic";
      throw new Error(
        `Invalid tool name(s) for ${providerLabel}: ${nameList}. Tool names must only contain letters, numbers, underscores, and hyphens (max 64 characters).`
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
          `MCP tool '${name}' collides with the progressive-discovery meta-tool of the same name. Rename the MCP tool or set MCPJAM_PROGRESSIVE_TOOLS=off.`
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
    : temperature ?? DEFAULT_TEMPERATURE;

  // 5. Message scrubber
  const scrubMessages = (msgs: ModelMessage[]) =>
    scrubChatGPTAppsToolResultsForBackend(
      scrubMcpAppsToolResultsForBackend(
        scrubUnavailableToolHistoryForBackend(msgs, availableToolNames),
        mcpClientManager,
        knownSelectedServers
      ),
      mcpClientManager,
      knownSelectedServers
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
