/**
 * Shared chat-v2 tool preparation and message scrubbing.
 *
 * Encapsulates the identical prep logic used by both mcp/chat-v2 and web/chat-v2:
 *   1. getToolsForAiSdk + the turn's skill source + needsApproval merge
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
import { markUserServerHop } from "./route-error-report.js";
import { mcpToolOptionsFor } from "./mcp-tool-options.js";
import {
  MCPClientManager,
  describeError,
  type Harness,
  type ToolTaskSeamOptions,
} from "@mcpjam/sdk";
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
import {
  getPinnedSkillToolsAndPrompt,
  type SkillsFetchFailure,
} from "./computers/cloud-skill-tools.js";
import { getEffectiveSkillToolsAndPrompt } from "./computers/effective-skill-tools.js";
import {
  SERVER_SKILLS_PROMPT_SECTION,
  withServerSkills,
} from "./server-skill-tools.js";
import type { EffectiveCapabilitySet } from "../services/environments/effective-capabilities.js";
import type { PinnableSkill } from "../../shared/skill-types.js";
import { logger } from "./logger.js";
import {
  modelDefinitionSupportsTemperature,
  type ModelDefinition,
} from "@/shared/types";
import {
  PAGE_TOOL_ALIAS_REGEX,
  UI_TOOL_NAME_REGEX,
  pageToolCallNeedsApproval,
  uiToolCallNeedsApproval,
  type UiToolAnnotations,
} from "@/shared/client-fulfilled-tools";
import {
  WEBMCP_TOOL_DESCRIPTION_MAX_CHARS,
  WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES,
  WEBMCP_TOOL_MAX_ENTRIES,
  WEBMCP_TOOL_NAME_MAX_CHARS,
} from "@/shared/webmcp-inspector-protocol";
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
/**
 * WebMCP-shaped MCPJam UI tool descriptor as accepted by `prepareChatV2`,
 * already sanitized by {@link validateUiToolEntries}. Mirrors
 * `UiToolSnapshotEntry` in `shared/mcpjam-ui-tools.ts`. Unlike app tools
 * there is no alias indirection: `name` (reserved `ui_` prefix) is the
 * model-facing tool name, fulfilled client-side in the browser.
 */
export type UiToolEntry =
  import("@/shared/mcpjam-ui-tools").UiToolSnapshotEntry;
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
// UI tool caps mirror the client snapshotter at
// `client/src/lib/webmcp/ui-tools-registry.ts`. The name regex lives in
// `shared/client-fulfilled-tools.ts` so the no-execute gates in the MCPJam
// free-model loop can never drift from the validator.
const UI_TOOL_MAX_ENTRIES = 64;
const UI_TOOL_MAX_DESCRIPTION_CHARS = 512;
const UI_TOOL_MAX_INPUT_SCHEMA_BYTES = 8 * 1024;
const WIDGET_MODEL_CONTEXT_MAX_ENTRIES = 32;
const WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS = 32;
const WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES = 64 * 1024;
// WebMCP Inspector page-tool caps. Same shape as the app-tool caps above, and
// deliberately no more generous: the entries describe tools a third-party page
// registered, so every field here is attacker-influenced text.

export class AppToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppToolValidationError";
  }
}

export class UiToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiToolValidationError";
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
  maxBytes: number,
): void {
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    throw new WidgetModelContextValidationError(
      `${label} is not JSON-serializable`,
    );
  }
  if (size > maxBytes) {
    throw new WidgetModelContextValidationError(
      `${label} exceeds ${maxBytes} bytes`,
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
        size = new TextEncoder().encode(JSON.stringify(raw.inputSchema)).length;
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

/** MCP `ToolAnnotations` hints accepted on a UI tool snapshot entry. */
const UI_TOOL_ANNOTATION_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/**
 * Validate the optional `annotations` object on a UI tool snapshot entry.
 *
 * Boolean-only, known keys only. Unknown keys are rejected rather than
 * dropped: this snapshot drives approval policy, so a typo'd hint must not
 * pass silently as "absent" (which, for `destructiveHint`, flips the meaning
 * from additive to destructive).
 */
function validateUiToolAnnotations(
  raw: unknown,
  index: number,
): UiToolAnnotations | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UiToolValidationError(
      `uiTools[${index}].annotations must be an object`,
    );
  }
  const out: UiToolAnnotations = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(UI_TOOL_ANNOTATION_KEYS as readonly string[]).includes(key)) {
      throw new UiToolValidationError(
        `uiTools[${index}].annotations has unknown key '${key}'`,
      );
    }
    if (typeof value !== "boolean") {
      throw new UiToolValidationError(
        `uiTools[${index}].annotations.${key} must be a boolean`,
      );
    }
    out[key as (typeof UI_TOOL_ANNOTATION_KEYS)[number]] = value;
  }
  return out;
}

/**
 * Validate and normalize the client-supplied `uiTools` snapshot.
 *
 * Returns a cleaned array of {@link UiToolEntry} or throws
 * {@link UiToolValidationError} — routes turn the throw into a 400.
 *
 * Same defensive posture as {@link validateAppToolEntries}: nothing here
 * trusts the client snapshotter to have enforced the caps. The `ui_` name
 * regex is a strict subset of the Anthropic tool-name charset, so validated
 * entries can never trip the provider name gate.
 */
export function validateUiToolEntries(input: unknown): UiToolEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new UiToolValidationError("uiTools must be an array");
  }
  if (input.length > UI_TOOL_MAX_ENTRIES) {
    throw new UiToolValidationError(
      `uiTools accepts at most ${UI_TOOL_MAX_ENTRIES} entries, got ${input.length}`,
    );
  }
  const out: UiToolEntry[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") {
      throw new UiToolValidationError(`uiTools[${i}] must be an object`);
    }
    const name = raw.name;
    if (typeof name !== "string" || !UI_TOOL_NAME_REGEX.test(name)) {
      throw new UiToolValidationError(
        `uiTools[${i}].name must match ${UI_TOOL_NAME_REGEX}`,
      );
    }
    if (seenNames.has(name)) {
      throw new UiToolValidationError(
        `uiTools[${i}].name '${name}' is duplicated`,
      );
    }
    seenNames.add(name);
    if (
      typeof raw.description !== "string" ||
      raw.description.trim().length === 0
    ) {
      throw new UiToolValidationError(
        `uiTools[${i}].description must be a non-empty string`,
      );
    }
    if (raw.description.length > UI_TOOL_MAX_DESCRIPTION_CHARS) {
      throw new UiToolValidationError(
        `uiTools[${i}].description exceeds ${UI_TOOL_MAX_DESCRIPTION_CHARS} chars`,
      );
    }
    let inputSchema: Record<string, unknown> | undefined;
    if (raw.inputSchema !== undefined) {
      if (
        raw.inputSchema === null ||
        typeof raw.inputSchema !== "object" ||
        Array.isArray(raw.inputSchema)
      ) {
        throw new UiToolValidationError(
          `uiTools[${i}].inputSchema must be a JSON object`,
        );
      }
      let size = 0;
      try {
        size = new TextEncoder().encode(JSON.stringify(raw.inputSchema)).length;
      } catch {
        throw new UiToolValidationError(
          `uiTools[${i}].inputSchema is not JSON-serializable`,
        );
      }
      if (size > UI_TOOL_MAX_INPUT_SCHEMA_BYTES) {
        throw new UiToolValidationError(
          `uiTools[${i}].inputSchema exceeds ${UI_TOOL_MAX_INPUT_SCHEMA_BYTES} bytes`,
        );
      }
      inputSchema = raw.inputSchema as Record<string, unknown>;
    }
    if (typeof raw.readOnly !== "boolean") {
      throw new UiToolValidationError(
        `uiTools[${i}].readOnly must be a boolean`,
      );
    }
    const annotations = validateUiToolAnnotations(raw.annotations, i);
    if (
      annotations?.readOnlyHint !== undefined &&
      annotations.readOnlyHint !== raw.readOnly
    ) {
      // A snapshot that says both "read-only" and "not read-only" has no safe
      // reading: trusting `readOnlyHint` would let a contradictory entry skip
      // approval. Reject rather than pick a winner.
      throw new UiToolValidationError(
        `uiTools[${i}].annotations.readOnlyHint must equal readOnly`,
      );
    }
    out.push({
      name,
      description: raw.description,
      inputSchema,
      readOnly: raw.readOnly,
      ...(annotations ? { annotations } : {}),
    });
  }
  return out;
}

export function validateWidgetModelContextEntries(
  input: unknown,
): WidgetModelContextEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new WidgetModelContextValidationError(
      "widgetModelContext must be an array",
    );
  }
  if (input.length > WIDGET_MODEL_CONTEXT_MAX_ENTRIES) {
    throw new WidgetModelContextValidationError(
      `widgetModelContext accepts at most ${WIDGET_MODEL_CONTEXT_MAX_ENTRIES} entries, got ${input.length}`,
    );
  }

  return input.map((entry, i): WidgetModelContextEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WidgetModelContextValidationError(
        `widgetModelContext[${i}] must be an object`,
      );
    }
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.toolCallId !== "string" ||
      raw.toolCallId.length === 0 ||
      raw.toolCallId.length > APP_TOOL_MAX_NAME_CHARS
    ) {
      throw new WidgetModelContextValidationError(
        `widgetModelContext[${i}].toolCallId must be a non-empty string ≤${APP_TOOL_MAX_NAME_CHARS} chars`,
      );
    }
    if (
      !raw.context ||
      typeof raw.context !== "object" ||
      Array.isArray(raw.context)
    ) {
      throw new WidgetModelContextValidationError(
        `widgetModelContext[${i}].context must be an object`,
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
          `widgetModelContext[${i}].context.content must be an array`,
        );
      }
      if (context.content.length > WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS) {
        throw new WidgetModelContextValidationError(
          `widgetModelContext[${i}].context.content accepts at most ${WIDGET_MODEL_CONTEXT_MAX_CONTENT_BLOCKS} blocks`,
        );
      }
      for (let j = 0; j < context.content.length; j++) {
        const block = context.content[j];
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          throw new WidgetModelContextValidationError(
            `widgetModelContext[${i}].context.content[${j}] must be an object`,
          );
        }
      }
      assertJsonByteSize(
        context.content,
        `widgetModelContext[${i}].context.content`,
        WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES,
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
          `widgetModelContext[${i}].context.structuredContent must be an object`,
        );
      }
      assertJsonByteSize(
        context.structuredContent,
        `widgetModelContext[${i}].context.structuredContent`,
        WIDGET_MODEL_CONTEXT_MAX_JSON_BYTES,
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
  block: Record<string, unknown>,
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
  entries: WidgetModelContextEntry[],
): string {
  if (entries.length === 0) return "";

  const sections = entries.map((entry) => {
    const lines = [`Widget context from tool call \`${entry.toolCallId}\`:`];
    const content = entry.context.content ?? [];
    if (content.length > 0) {
      lines.push(
        "Content:",
        ...content.map((block) => renderWidgetContextContentBlock(block)),
      );
    }
    if (entry.context.structuredContent) {
      lines.push(
        "Structured content:",
        "```json",
        JSON.stringify(entry.context.structuredContent, null, 2),
        "```",
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
  calls: ReadonlyArray<{ toolName: string; result?: unknown }>,
): string {
  if (calls.length === 0) return "";

  const sections = calls.map((call) => {
    const result = call.result as
      { content?: Array<Record<string, unknown>> } | undefined;
    const content = result?.content ?? [];
    const lines = [
      `The user interacted with the \`${call.toolName}\` MCP App widget, which called the \`${call.toolName}\` tool. It returned:`,
    ];
    if (content.length > 0) {
      lines.push(
        ...content.map((block) => renderWidgetContextContentBlock(block)),
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
  /**
   * serverId → the user-assigned label from OUR server registry, used to
   * namespace SEP-2640 server-skill refs (`<serverSlug>/<skill>`).
   *
   * Host-assigned on purpose: `serverInfo.name` is server-controlled, so
   * deriving the namespace from it would let one server squat another's. A
   * missing label falls back to the server id — uglier, still safe.
   */
  serverLabels?: Record<string, string>;
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
  /**
   * MCP tool names this surface refuses to advertise, whichever server offers
   * them. Applied right after the visibility filter, so it only ever removes
   * SERVER tools — skills, app tools and UI tools are merged later and are
   * untouched.
   *
   * Distinct from `respectToolVisibility`, which honors a policy the SERVER
   * declares. This is the HOST declining a tool the server is happy to offer,
   * so it is a per-surface decision with deliberately no default: a surface
   * that wants nothing filtered omits it.
   *
   * Names are unqualified because `getToolsForAiSdk` flattens every selected
   * server into one name-keyed set (last-in wins on collision) — there is no
   * per-server key to target at this layer, and a name colliding across
   * servers is precisely the case you want removed wholesale rather than
   * silently resolved in favor of whichever server sorted last.
   */
  excludeMcpToolNames?: readonly string[];
  /** Host/client policy for eligible MCP tool-result content/resources. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  customProviders?: CustomProviderConfig[];
  /** Progressive discovery overrides (e.g. tighter thresholds for tests). */
  progressiveToolDiscovery?: ProgressiveDiscoveryOptions;
  /**
   * Resolved host harness. Harness runtimes own native tool discovery, so
   * MCPJam's progressive meta-tools must stay out of their prepared tool set.
   */
  harness?: Harness;
  /**
   * Resolved task-seam options, or absent for "tasks off".
   *
   * The MODE is resolved by the route (from the host policy and its own
   * `TaskSurface`), never here: web chat, local chat and the agent all reach
   * this function, and they are three different surfaces in the policy matrix.
   * Absent leaves `toolOptions` undefined for a default turn, which is what
   * keeps those turns byte-identical.
   */
  tasks?: ToolTaskSeamOptions;
  /**
   * Prior conversation messages, used to hydrate progressive discovery
   * state across turns. Without these, `discoveryState.loadedToolIds`
   * resets every request and any tools the model loaded earlier in the
   * session disappear — multi-turn flows regress to meta-tools only.
   */
  priorMessages?: ReadonlyArray<ModelMessage>;
  appTools?: AppToolEntry[];
  /** WebMCP-shaped MCPJam UI tools (client-fulfilled, like `appTools`). */
  uiTools?: UiToolEntry[];
  /**
   * Browser-native WebMCP tools from a page the WebMCP Inspector has open.
   * Client-fulfilled like `appTools`, and always approval-gated: unlike the
   * two above, these run code on a third-party site.
   */
  pageTools?: PageToolEntry[];
  /** Server-side built-in tools (e.g. web_search) with their own execute. */
  builtInTools?: ToolSet;
  /**
   * When set, skills are sourced from the caller's **Computer** (E2B sandbox)
   * instead of the local filesystem — the hosted/`/web` path. Only set by
   * callers whose host actually has a computer, so "advertise == enforce".
   * The turn's only skill source.
   */
  /**
   * Explicit skill source, ABOVE the cloud/HOSTED/local chain. Chat callers on
   * the legacy paths never set it → the existing precedence is byte-identical.
   *
   *  - `pinned`   — EVAL RUNNERS ONLY. Frozen in-memory tools over snapshotted
   *    content (zero network in execute). Tools bypass approval: pure reads of
   *    frozen content under an auto-deny eval run.
   *  - `resolved` — a Project-Environment turn. Same in-memory delivery,
   *    DIFFERENT policy: this is an ordinary interactive turn, so the skill
   *    tools follow the host's normal `requireToolApproval` rule. The eval
   *    approval exemption is deliberately NOT inherited — a user watching their
   *    own turn should still get the approval prompt they configured. It
   *    carries the whole `EffectiveCapabilitySet` rather than a skill list
   *    (INS-3) because the tools address skills by REF: a plugin skill is
   *    `<plugin>/<skill>`, and the origin/file metadata the ref surface needs
   *    lives on the set, not on a flattened `PinnableSkill`.
   *  - `pinned-effective` — EVAL RUNNERS ONLY, for a run whose pins carry a
   *    plugin `modelRef` or supporting FILES (INS-5). Same frozen-content,
   *    approval-exempt policy as `pinned`; the ref-addressed `resolved` tool
   *    surface, because a bare-name surface cannot express `<plugin>/<skill>`
   *    and has no file tools to serve a pinned `scripts/` directory with. The
   *    set is built from the RUN SNAPSHOT, so "in-memory over frozen content"
   *    still holds — the only network is the signed `_storage` GET for a file
   *    the model actually asks for, and that URL was minted against the pinned
   *    blob, not the live one.
   *  - `none`     — suppress skills entirely.
   *
   * `resolved` and the two pinned kinds are separate kinds rather than one
   * "in-memory" kind with a flag precisely because that approval divergence is
   * the whole distinction, and a shared kind would make it a caller's job to
   * remember.
   */
  skillsSource?:
    | { kind: "pinned"; skills: PinnableSkill[] }
    | {
        kind: "pinned-effective";
        capabilities: EffectiveCapabilitySet;
        /** See `resolved` below — same reason, same lifetime. */
        abortSignal?: AbortSignal;
      }
    | {
        kind: "resolved";
        capabilities: EffectiveCapabilitySet;
        /**
         * The turn's abort signal. Carried HERE rather than added to
         * `PrepareChatV2Options` because this is the only consumer: a skill
         * supporting-file read fetches a signed `_storage` URL, and without it
         * that fetch runs its full 30s timeout after the client has already
         * disconnected.
         */
        abortSignal?: AbortSignal;
        /**
         * Whether to ALSO compose live SEP-2640 skills from the connected
         * servers (see the `withServerSkills` block below).
         *
         * Opt-in, and the distinction is the whole reason this flag exists.
         * An ENVIRONMENT-resolved set is a snapshot: its server skills were
         * captured, and fetching more from a live connection would falsify the
         * claim that the set describes the turn. An INTERACTIVE surface — the
         * desktop app, the hosted Playground's default target — resolves no
         * environment; its set is just "what the user has right now", and its
         * server skills are only available live. Without this flag those
         * surfaces would lose server skills the moment they started passing a
         * `skillsSource` at all, which is exactly how a convergence quietly
         * drops a capability.
         */
        composeLiveServerSkills?: boolean;
      }
    | { kind: "none" };
}

/**
 * AI SDK tool entry with no `execute`, on purpose: `streamText` will stream
 * the tool-call to the client, where `useChat.onToolCall` fulfills it and
 * supplies the result back via `addToolOutput`.
 */
function toNoExecuteAiSdkTool(args: {
  description: string;
  inputSchema?: Record<string, unknown>;
  needsApproval?: boolean;
}) {
  return tool({
    description: args.description,
    inputSchema: jsonSchema(
      (args.inputSchema as Parameters<typeof jsonSchema>[0]) ?? {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    ),
    ...(args.needsApproval ? { needsApproval: true } : {}),
    // No execute — client fulfills via onToolCall.
  });
}

/**
 * Build no-execute AI SDK tool entries from the client snapshot.
 *
 * All app-provided tools are emitted. `readOnly` is preserved in the snapshot
 * for policy/telemetry, but MCPJam does not force approval for app-provided
 * tools here; normal server-tool approval remains scoped to server tools.
 * (UI tools DO gate on approval now — see `buildUiTools`. Extending the same
 * treatment to app tools is a deliberate follow-up: `app_<8hex>` aliases need
 * their own fulfillment UX in the iframe bridge first.)
 */
export function buildAppTools(appTools: AppToolEntry[] | undefined): ToolSet {
  if (!appTools || appTools.length === 0) return {};
  const out: ToolSet = {};
  for (const t of appTools) {
    out[t.alias] = toNoExecuteAiSdkTool({
      description: `[${t.appName}] ${t.description ?? t.rawName}`,
      inputSchema: t.inputSchema,
    });
  }
  return out;
}

/**
 * Build no-execute AI SDK tool entries for the WebMCP UI tools snapshot.
 * Same client-fulfilled contract as {@link buildAppTools}.
 *
 * When the turn's `requireToolApproval` flag is on, non-readOnly UI tools
 * get `needsApproval` so the BYOK `streamText` path pauses and emits a
 * `tool-approval-request` the client renders as the Approve/Deny pill.
 * NOTE the client resolves an APPROVED `ui_*` call by executing it and
 * supplying the tool-result directly (never a bare approval response) —
 * the server cannot execute a no-execute tool, so an approval response
 * without a result would strand the turn. Denials use the normal approval
 * response and the existing denial machinery.
 */
export function buildUiTools(
  uiTools: UiToolEntry[] | undefined,
  opts?: { requireToolApproval?: boolean },
): ToolSet {
  if (!uiTools || uiTools.length === 0) return {};
  const out: ToolSet = {};
  for (const t of uiTools) {
    out[t.name] = toNoExecuteAiSdkTool({
      description: t.description,
      inputSchema: t.inputSchema,
      needsApproval: uiToolCallNeedsApproval({
        readOnly: t.readOnly,
        annotations: t.annotations,
        requireToolApproval: opts?.requireToolApproval === true,
      }),
    });
  }
  return out;
}

/** One WebMCP page tool, as the client snapshots it for a turn. */
export interface PageToolEntry {
  /** Model-facing opaque alias, `page_<8hex>`. */
  alias: string;
  /** Inspector session that owns the browser this tool lives in. */
  sessionId: string;
  /** Stable `origin::name` key the inspector invokes by. */
  toolKey: string;
  /** The name the page registered, for display and prompt text. */
  rawName: string;
  /** Origin that registered it — the model is told, so it knows whose tool this is. */
  origin: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class PageToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageToolValidationError";
  }
}

/**
 * Validate the page-tool snapshot a turn advertised.
 *
 * Everything here originates on a third-party web page, so it is bounded the
 * same way the app-tool snapshot is rather than trusted for being "ours".
 */
export function validatePageToolEntries(input: unknown): PageToolEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new PageToolValidationError("pageTools must be an array");
  }
  if (input.length > WEBMCP_TOOL_MAX_ENTRIES) {
    throw new PageToolValidationError(
      `pageTools accepts at most ${WEBMCP_TOOL_MAX_ENTRIES} entries, got ${input.length}`,
    );
  }
  const out: PageToolEntry[] = [];
  const seenAliases = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") {
      throw new PageToolValidationError(`pageTools[${i}] must be an object`);
    }
    const alias = raw.alias;
    if (typeof alias !== "string" || !PAGE_TOOL_ALIAS_REGEX.test(alias)) {
      throw new PageToolValidationError(
        `pageTools[${i}].alias must match ${PAGE_TOOL_ALIAS_REGEX}`,
      );
    }
    if (seenAliases.has(alias)) {
      throw new PageToolValidationError(
        `pageTools[${i}].alias '${alias}' is duplicated`,
      );
    }
    seenAliases.add(alias);
    const str = (key: "sessionId" | "toolKey" | "rawName" | "origin") => {
      const value = raw[key];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > WEBMCP_TOOL_NAME_MAX_CHARS
      ) {
        throw new PageToolValidationError(
          `pageTools[${i}].${key} must be a non-empty string ≤${WEBMCP_TOOL_NAME_MAX_CHARS} chars`,
        );
      }
      return value;
    };
    const sessionId = str("sessionId");
    const toolKey = str("toolKey");
    const rawName = str("rawName");
    const origin = str("origin");

    let description: string | undefined;
    if (raw.description !== undefined) {
      if (
        typeof raw.description !== "string" ||
        raw.description.length > WEBMCP_TOOL_DESCRIPTION_MAX_CHARS
      ) {
        throw new PageToolValidationError(
          `pageTools[${i}].description must be a string ≤${WEBMCP_TOOL_DESCRIPTION_MAX_CHARS} chars`,
        );
      }
      description = raw.description;
    }

    let inputSchema: Record<string, unknown> | undefined;
    if (raw.inputSchema !== undefined) {
      if (
        typeof raw.inputSchema !== "object" ||
        raw.inputSchema === null ||
        Array.isArray(raw.inputSchema)
      ) {
        throw new PageToolValidationError(
          `pageTools[${i}].inputSchema must be an object`,
        );
      }
      const bytes = Buffer.byteLength(JSON.stringify(raw.inputSchema), "utf8");
      if (bytes > WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES) {
        throw new PageToolValidationError(
          `pageTools[${i}].inputSchema exceeds ${WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES} bytes`,
        );
      }
      inputSchema = raw.inputSchema as Record<string, unknown>;
    }

    out.push({
      alias,
      sessionId,
      toolKey,
      rawName,
      origin,
      description,
      inputSchema,
    });
  }
  return out;
}

/**
 * Build no-execute AI SDK entries for the WebMCP page tools.
 *
 * Client-fulfilled like `app_*` and `ui_*`: the inspector's browser session
 * lives in the same process as the client's store, and the client already owns
 * the approval handshake, so routing execution back through the server would
 * add a round trip and a second approval path for no gain.
 *
 * `needsApproval` is unconditional — see `pageToolCallNeedsApproval`. The
 * description carries the origin because a model choosing between tools should
 * be able to see whose page each one belongs to.
 */
export function buildPageTools(
  pageTools: PageToolEntry[] | undefined,
): ToolSet {
  if (!pageTools || pageTools.length === 0) return {};
  const out: ToolSet = {};
  for (const entry of pageTools) {
    out[entry.alias] = toNoExecuteAiSdkTool({
      description: `[WebMCP page tool — ${entry.origin}] ${
        entry.description ?? entry.rawName
      }`,
      inputSchema: entry.inputSchema,
      needsApproval: pageToolCallNeedsApproval(),
    });
  }
  return out;
}

/**
 * System-prompt section advertising the UI tools. Empty when none were
 * snapshotted — or when none survived collision resolution — so surfaces
 * without UI tools keep a byte-identical prompt. Callers must pass the
 * EFFECTIVE entry set for the turn: each sentence naming specific catalog
 * tools is gated on every tool it mentions being present, so the prompt
 * never tells the model to call a UI tool that isn't advertised.
 */
export function buildUiToolsSystemPrompt(
  uiTools: UiToolEntry[] | undefined,
  opts?: { requireToolApproval?: boolean },
): string {
  if (!uiTools || uiTools.length === 0) return "";
  const names = new Set(uiTools.map((t) => t.name));
  const has = (...toolNames: string[]) => toolNames.every((n) => names.has(n));
  const lines = [
    "## MCPJam UI tools",
    "You can drive the MCPJam inspector itself with the `ui_*` tools. Every action happens in the user's open app and is immediately visible to them.",
  ];
  if (has("ui_open_playground", "ui_select_tool", "ui_execute_tool")) {
    lines.push(
      "Prefer `ui_open_playground` before `ui_select_tool` / `ui_execute_tool`. `ui_execute_tool` REALLY runs a tool against the user's connected MCP server — treat it as side-effectful; when the user hasn't clearly asked to run a tool, prefill it with `ui_select_tool` instead.",
    );
  }
  if (has("ui_snapshot_app")) {
    lines.push(
      "`ui_snapshot_app` is read-only and works from anywhere — use it to see where the user is and what is selected before acting, rather than assuming.",
    );
  }
  lines.push(
    "When a `ui_*` tool returns an error, relay the reason instead of retrying blindly.",
    approvalGuidance(uiTools, opts?.requireToolApproval === true),
  );
  return lines.join("\n");
}

/**
 * The approval sentence, told honestly for the snapshot that was actually
 * sent. The destructive-pauses promise only holds when EVERY entry is
 * annotation-aware — a legacy client sends bare `readOnly`, whose predicate
 * with the flag off is `requireToolApproval && !readOnly`, i.e. nothing
 * pauses. Promising a destructive gate there advertises a safety net that
 * isn't there.
 */
function approvalGuidance(
  uiTools: UiToolEntry[],
  requireToolApproval: boolean,
): string {
  if (requireToolApproval) {
    return "Every mutating `ui_*` action pauses for the user's explicit approval before it runs. A denial is final — explain what you wanted to do instead of retrying the call.";
  }
  const annotationAware = uiTools.every((t) => t.annotations !== undefined);
  return annotationAware
    ? "Destructive `ui_*` actions pause for the user's explicit approval before they run; other actions apply immediately. A denial is final — explain what you wanted to do instead of retrying the call."
    : "Every `ui_*` action applies immediately, so be deliberate about mutating ones — describe what you're about to do when it isn't obviously what the user asked for.";
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
  /**
   * MCPJam UI tool entries that survived collision resolution against the
   * loaded MCP tools (server tool wins an exact `ui_*` name collision).
   * Approval classification for client-fulfilled UI calls must use THIS set,
   * never the raw snapshot — a server-executed tool named `ui_navigate` must
   * not inherit MCPJam UI approval semantics from a discarded client entry.
   */
  effectiveUiTools: UiToolEntry[];
  /**
   * Set when the live-cloud catalog fetch threw or timed out. Distinguishes
   * that skip from a genuine empty project (no marker). Session-sim can
   * forward this as a `session_notice`.
   */
  skillsFetchFailed?: SkillsFetchFailure;
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
    respectToolVisibility,
    excludeMcpToolNames,
    modelVisibleMcpToolResults,
    customProviders,
    appTools,
    uiTools,
    pageTools,
    builtInTools,
    skillsSource,
    harness,
    tasks,
    serverLabels,
  } = options;

  // Drop ids the manager hasn't registered (server disabled/disconnected, or
  // a stale id baked into a scenario config). Passing them through reaches
  // ensureConnected and throws "Unknown MCP server", 500-ing the whole chat.
  const knownSelectedServers = selectedServers?.filter((id) =>
    mcpClientManager.hasServer(id),
  );

  // `undefined` for every default turn, which is what keeps those turns on the
  // pre-existing no-options overload. See `mcpToolOptionsFor`.
  const toolOptions = mcpToolOptionsFor({
    needsApproval: requireToolApproval,
    includeAppOnly: respectToolVisibility === false,
    modelVisibleMcpToolResults,
    tasks,
  });

  // 1. Get MCP + skill tools
  let mcpTools;
  try {
    mcpTools = await mcpClientManager.getToolsForAiSdk(
      knownSelectedServers,
      toolOptions,
    );
  } catch (error) {
    // The ONE hop in this function that leaves MCPJam: listing tools reaches
    // into the user's own MCP servers, so a dead or slow server lands here.
    // The chat route's outer catch declares `mcpjam_internal` — correct for
    // everything else it wraps — and without this mark that declaration would
    // promote every one of those to a page.
    //
    // Scoped to this await on purpose. Marking the whole of `prepareChatV2`
    // would silence a genuine bug in the preparation work that follows, which
    // is MCPJam's and has no other capture point.
    //
    // This call is not purely a network hop either — it also converts and
    // flattens the results into an AI SDK tool set, which is our code. A
    // programming fault in that conversion is ours and keeps the internal
    // verdict; everything else is the user's hop.
    //
    // The split is made by the CLASSIFIER, not by the error's constructor.
    // `error instanceof TypeError` looks like it names a programming fault and
    // does not: undici reports a dead HTTP server as `TypeError: fetch
    // failed`, which the describer resolves to `transport/fetch_failed`. A
    // type-based rule would hand every dead user server straight back to the
    // internal boundary — the exact attribution this mark exists to prevent.
    // Only a native error type the describer ALSO cannot place stays ours.
    const isProgrammerFault =
      (error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError) &&
      describeError(error).slug === "internal/unknown";
    if (isProgrammerFault) {
      throw error;
    }
    throw markUserServerHop(error);
  }

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
  // Host-declined server tools (see `excludeMcpToolNames`). Deletes by name
  // across the flattened set, so a name offered by two selected servers is
  // removed for both rather than leaving whichever one won the flatten.
  if (excludeMcpToolNames?.length) {
    for (const name of excludeMcpToolNames) {
      delete (mcpTools as Record<string, unknown>)[name];
    }
  }
  // ONE skill source per turn, stated by the caller. Where a skill comes FROM —
  // the project, a plugin, a connected server, this machine's filesystem — is a
  // property of the skill inside an `EffectiveCapabilitySet`, not a mode the
  // orchestrator picks between:
  //   - `pinned` / `pinned-effective` ⇒ frozen eval content; the ONLY kinds
  //     that bypass approval (decision 12), because an eval run auto-denies.
  //   - `resolved` ⇒ a live or environment-resolved set, keeping the host's
  //     approval rule. `composeLiveServerSkills` says which of the two it is.
  //   - `none` ⇒ no skills, said deliberately.
  // Every surface inlines its catalog in the prompt; there is no `listSkills`
  // discovery tool on any of them.
  const skillsArePinned =
    skillsSource?.kind === "pinned" ||
    skillsSource?.kind === "pinned-effective";
  // The two skill-delivery channels are deliberately DISJOINT, and this is the
  // single point both funnel through. A harness turn materializes SKILL.md on
  // the box from `pinnedHarnessSkills` (see `utils/harness/skill-delivery.ts`);
  // an emulated turn gets in-memory `loadSkill` tools from `skillsSource`.
  // Delivering both would hand the model the same skill twice, by two mechanisms.
  //
  // So this is a CALLER contract, not a statement about what a harness can do:
  // harness callers pass `{ kind: "none" }` here and put their pins on
  // `pinnedHarnessSkills`. (Historical note: this once read "harness runs
  // live-fetch skills" — that stopped being true when on-box pinned delivery
  // landed, and the stale wording cost real debugging time. `run-harness-turn`
  // does not call `fetchRuntimeSkills` at all in pinned mode.)
  if (harness && skillsSource !== undefined && skillsSource.kind !== "none") {
    // Generalized from "pinned" to ANY in-memory source. The rule was always
    // about DOUBLE DELIVERY; `pinned` was merely the only shape a harness
    // caller could reach when it was written. Once `resolved` became the shape
    // every live surface passes, a harness turn carrying one would have been
    // handed the same skill twice — as SKILL.md on the box AND as a `loadSkill`
    // tool — with nothing to catch it, because callers guard this themselves
    // and a forgotten guard is silent.
    throw new Error(
      "Harness turns receive skills on box via `pinnedHarnessSkills`, not via " +
        "`skillsSource`. Pass `skillsSource: { kind: 'none' }` for a harness " +
        "turn — the two delivery channels are deliberately disjoint.",
    );
  }
  const modelContextTokens =
    modelDefinition.contextLength !== undefined
      ? { modelContextTokens: modelDefinition.contextLength }
      : {};
  type SkillPrep = {
    tools: Record<string, unknown>;
    systemPromptSection: string;
    skillsFetchFailed?: SkillsFetchFailure;
  };
  const skillPrep: SkillPrep = skillsSource
    ? skillsSource.kind === "pinned"
      ? getPinnedSkillToolsAndPrompt(skillsSource.skills, modelContextTokens)
      : skillsSource.kind === "resolved" ||
          skillsSource.kind === "pinned-effective"
        ? getEffectiveSkillToolsAndPrompt(skillsSource.capabilities, {
            ...(skillsSource.abortSignal
              ? { signal: skillsSource.abortSignal }
              : {}),
            // The discovery listing is budgeted against THIS model's context
            // (INS-3 / OpenAI's 2% rule). `contextLength` is optional on a
            // model definition; the budget helper falls back to 8,000 chars.
            ...modelContextTokens,
          })
        : { tools: {}, systemPromptSection: "" }
    : // Every caller states its source now, so there is no implicit arm left to
      // fall through to. The old chain ended `cloudSkills ? … : HOSTED_MODE ? {}
      // : localFS` — exclusive arms, chosen by DEPLOYMENT rather than by what
      // the user had, which is why a desktop turn could never see a project
      // skill and a hosted one could never see a local file. A caller with no
      // skills says `{ kind: "none" }` and means it.
      { tools: {}, systemPromptSection: "" };
  const {
    tools: skillTools,
    systemPromptSection: skillsPromptSection,
    skillsFetchFailed,
  } = skillPrep;

  // Pinned skill tools NEVER require approval (pure reads of frozen content; the
  // eval run is auto-deny). Otherwise the normal approval wrap applies.
  const approvalWrappedSkillTools: Record<string, unknown> =
    requireToolApproval && !skillsArePinned
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

  // Skills over MCP (SEP-2640), LIVE path. A COMPOSING wrapper, not a fifth
  // arm of the chain above: the chain is an exclusive choice, but a turn can
  // legitimately have both a Computer skill and a skill served by a connected
  // MCP server, and picking one would silently drop the other.
  //
  // Excluded whenever an explicit skills source is present, and from harness
  // paths. Those sources are frozen, captured, or explicitly skill-less; a
  // live fetch would either falsify the snapshot claim or bypass `none`.
  //
  // Returns its input UNCHANGED when no selected server declares the
  // extension, which is what keeps every pre-existing turn byte-identical.
  // The wrapper applies its own always-on approval to server-origin loads —
  // see `server-skill-tools.ts` — regardless of `requireToolApproval`.
  // A LIVE turn composes server skills whether or not it also carries an
  // explicit source; a captured or frozen one never does. `skillsSource ===
  // undefined` is the legacy live shape (no caller passes it once every surface
  // is explicit); `resolved` + the opt-in flag is how a live surface says so
  // while still using the merged, ref-addressed catalog.
  const composeLiveServerSkills =
    !harness &&
    (skillsSource === undefined ||
      (skillsSource.kind === "resolved" &&
        skillsSource.composeLiveServerSkills === true));

  const finalSkillTools: Record<string, unknown> = !composeLiveServerSkills
    ? approvalWrappedSkillTools
    : withServerSkills(approvalWrappedSkillTools, {
        manager: mcpClientManager,
        // The UNFILTERED selection, deliberately — not `knownSelectedServers`.
        // Slug collision suffixes are assigned over whatever set they are
        // given, and the playground picker mints its refs from the raw
        // selection because it cannot see which ids the manager registered.
        // Handing the filtered list here would shift every suffix behind a
        // dropped id, so the picker's `acme-2/refunds` would address a
        // different server than `loadSkill`'s. `withServerSkills` filters to
        // extension-active servers itself, and an unregistered id is not
        // active, so nothing unknown is contacted either way.
        servers: (selectedServers ?? []).map((serverId) => ({
          serverId,
          // The user-assigned label from OUR registry, never
          // `serverInfo.name` — a server must not be able to choose the
          // namespace its skills are addressed under. Falls back to the
          // server id, which is host-assigned too and therefore still safe;
          // it just reads worse in a ref.
          serverLabel: serverLabels?.[serverId] ?? serverId,
        })),
      });

  // SEP-1865 App-Provided Tools (Host → App direction). Client supplies
  // the snapshot per chat POST; we register them as no-execute entries so
  // streamText streams the tool-call back to the client for in-iframe
  // dispatch via `AppBridge.callTool`. Merged after server tools and
  // before skills so an app alias never collides with either (the
  // `app_<8hex>` namespace is opaque and disjoint from both).
  const appToolEntries = buildAppTools(appTools);
  // WebMCP UI tools — client-fulfilled like app tools, but with curated
  // `ui_*` names instead of opaque aliases. `ui_` is a guessable prefix any
  // MCP server may legitimately ship, so on an exact name collision the
  // genuine server tool wins: the MCPJam UI entry is omitted for this turn
  // (with a warn) and the server tool keeps its execute + ordinary approval
  // semantics. A connected server must never lose a capability because
  // MCPJam's first-party catalog picked the same name. Everything UI-scoped
  // downstream — ToolSet entries, system prompt, discovery exemption,
  // approval classification — derives from this effective set, never the
  // raw snapshot.
  const effectiveUiTools = (uiTools ?? []).filter((entry) => {
    if (!Object.prototype.hasOwnProperty.call(mcpTools, entry.name)) {
      return true;
    }
    logger.warn(
      `[chat-v2] MCP server tool '${entry.name}' collides with the MCPJam UI tool of the same name; keeping the server tool and omitting the UI entry for this turn`,
    );
    return false;
  });
  const uiToolEntries = buildUiTools(effectiveUiTools, { requireToolApproval });
  // WebMCP page tools — client-fulfilled like app tools, and opaque in the same
  // way, so `page_<8hex>` cannot collide with a server tool, a UI tool or an
  // app alias. A collision here would mean two sessions minted the same alias,
  // which is a bug rather than a conflict to resolve, so it throws below.
  const pageToolEntries = buildPageTools(pageTools);
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
        `[chat-v2] built-in tool '${name}' shadows an MCP tool with the same name; using the built-in`,
      );
      delete mcpTools[name];
    }
    if (
      Object.prototype.hasOwnProperty.call(appToolEntries, name) ||
      Object.prototype.hasOwnProperty.call(uiToolEntries, name) ||
      Object.prototype.hasOwnProperty.call(pageToolEntries, name) ||
      Object.prototype.hasOwnProperty.call(finalSkillTools, name)
    ) {
      throw new Error(
        `Built-in tool '${name}' collides with an existing app, UI, page, or skill tool.`,
      );
    }
  }
  // A page alias colliding with anything already merged means two aliases were
  // minted the same, which is a bug in the minting rather than a configuration
  // to resolve — so it fails loudly instead of silently shadowing a tool.
  for (const name of Object.keys(pageToolEntries)) {
    if (
      Object.prototype.hasOwnProperty.call(mcpTools, name) ||
      Object.prototype.hasOwnProperty.call(appToolEntries, name) ||
      Object.prototype.hasOwnProperty.call(uiToolEntries, name) ||
      Object.prototype.hasOwnProperty.call(finalSkillTools, name)
    ) {
      throw new Error(
        `WebMCP page tool '${name}' collides with an existing tool of the same name.`,
      );
    }
  }
  // Built-ins merge last so an explicit built-in wins; the policy above has
  // already resolved (or rejected) every collision by here.
  const realTools = {
    ...mcpTools,
    ...appToolEntries,
    ...uiToolEntries,
    ...pageToolEntries,
    ...finalSkillTools,
    ...builtInToolEntries,
  } as ToolSet;

  // 2. Decide whether progressive discovery applies, then mint meta-tools if
  // it does. The catalog is built from real tools only (meta-tools aren't
  // searchable) but the meta-tools are then merged into the final ToolSet so
  // both streamText and the Convex loop see them.
  //
  // WebMCP UI tools are exempt from progressive discovery: the catalog is
  // what gets lazily loaded via `load_mcp_tools`, and both stream paths
  // treat non-cataloged entries as always-advertised, never-gated
  // "injected" tools (see direct-chat-turn / mcpjam-stream-handler).
  // Cataloging them would hide the `ui_*` tools behind a load step while
  // the system prompt advertises them unconditionally — and a 7-entry
  // first-party control surface is not what discovery exists to trim.
  //
  // WebMCP page tools are exempt for the same reason plus one of their own:
  // the user opened this page in the inspector precisely so the model could
  // use its tools, and gating them behind a search step would mean the model
  // has to guess that a page it was never told about is worth searching for.
  const catalogSource: ToolSet = { ...realTools };
  for (const name of [
    ...Object.keys(uiToolEntries),
    ...Object.keys(pageToolEntries),
  ]) {
    delete catalogSource[name];
  }
  const catalog = buildToolCatalog(catalogSource);
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
  const envOverride = harness
    ? false
    : parseProgressiveToolsEnv(process.env.MCPJAM_PROGRESSIVE_TOOLS);
  const progressivePlan = decideProgressivePlan({
    catalog,
    modelContextLength: modelDefinition.contextLength,
    options: harness
      ? { ...(options.progressiveToolDiscovery ?? {}), enabled: false }
      : options.progressiveToolDiscovery,
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
        `Invalid tool name(s) for ${providerLabel}: ${nameList}. Tool names must only contain letters, numbers, underscores, and hyphens (max 64 characters).`,
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
  //
  // The server-skills sentence is added ONLY when the wrapper actually
  // attached (identity change ⇒ at least one selected server declares the
  // extension). Advertising server skills to a turn that has none would invite
  // the model to go looking for refs that cannot resolve.
  const serverSkillsAttached = finalSkillTools !== approvalWrappedSkillTools;
  const enhancedSystemPrompt = [
    systemPrompt,
    skillsPromptSection
      ? serverSkillsAttached
        ? `${skillsPromptSection}${SERVER_SKILLS_PROMPT_SECTION}`
        : skillsPromptSection
      : serverSkillsAttached
        ? SERVER_SKILLS_PROMPT_SECTION
        : skillsPromptSection,
    buildUiToolsSystemPrompt(effectiveUiTools, { requireToolApproval }),
  ]
    .filter((section): section is string => Boolean(section?.trim()))
    .map((section) => section.trim())
    .join("\n\n");

  // 4. Temperature resolution
  //
  // An omitted temperature stays omitted rather than becoming 0.7, so a caller
  // that expressed no preference gets the provider's own default instead of one
  // this file invented. The chat UI always sends its slider value (0.7 until
  // moved), so this only changes programmatic callers — the SDK, the API and the
  // eval runner — which previously could not request default sampling at all.
  //
  // The persisted `hostConfig.temperature` is unaffected and stays numeric:
  // `buildDirectHostConfig` falls back to the requested value, then to 0.7.
  const resolvedTemperature = modelDefinitionSupportsTemperature(
    modelDefinition,
  )
    ? temperature
    : undefined;

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
    effectiveUiTools,
    ...(skillsFetchFailed ? { skillsFetchFailed } : {}),
  };
}
