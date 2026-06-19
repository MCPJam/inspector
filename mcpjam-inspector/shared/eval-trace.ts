import type { ModelMessage } from "ai";
import { z } from "zod";
import type { PromptTurnToolCall } from "./prompt-turns";

/** Persisted eval trace span categories (Convex: use the same literals in traceSpanValidator). */
export type EvalTraceSpanCategory = "step" | "llm" | "tool" | "error";
export type EvalTraceSpanStatus = "ok" | "error";

export type EvalTraceSpan = {
  id: string;
  parentId?: string;
  name: string;
  category: EvalTraceSpanCategory;
  startMs: number;
  endMs: number;
  promptIndex?: number;
  stepIndex?: number;
  status?: EvalTraceSpanStatus;
  toolCallId?: string;
  toolName?: string;
  serverId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Inclusive index of the first related trace message in the stored blob. */
  messageStartIndex?: number;
  /** Inclusive index of the last related trace message in the stored blob. */
  messageEndIndex?: number;
  // ── GenAI harness metadata (step/llm spans). OTel mapping in OTEL_ATTR. ──
  /**
   * Why the model stopped, normalized to a canonical vocabulary via
   * `normalizeFinishReason()` at the write site. OTel
   * `gen_ai.response.finish_reasons` (array; we emit singular per-span, n=1).
   * Advisory display only — never feed a gate/predicate.
   */
  finishReason?: string;
  /** Logical provider (e.g. "anthropic"). OTel `gen_ai.provider.name`. Threaded from config, never derived from modelId. */
  provider?: string;
  /** Provider completion id. OTel `gen_ai.response.id`. */
  responseId?: string;
  /** ISO-8601 UTC response timestamp. No direct OTel attr (informs span end time on export). Stored, not surfaced in v1 UI. */
  responseTimestamp?: string;
  /** Time to first streamed chunk, ms. OTel `gen_ai.response.time_to_first_chunk` (seconds — export as ttfcMs/1000). Undefined on non-streaming paths; advisory only. */
  ttfcMs?: number;
  // ── MCP server-contract metadata (tool spans) ──
  /**
   * JSON-RPC error code from a failed `tools/call` (OTel
   * `rpc.response.status_code`, e.g. -32602 invalid params). Present only on
   * protocol-level failures — a tool returning `isError: true` (domain error)
   * has no code per the MCP spec. Surfaces a server contract violation.
   */
  mcpErrorCode?: number;
};

/**
 * Canonical finish-reason vocabulary. The AI SDK already normalizes to most of
 * these; `normalizeFinishReason` additionally folds raw provider aliases
 * (`content_filter`, `max_tokens`, `end_turn`, …) so the badge's exact-match
 * check (`=== "content-filter"`) can't silently miss across capture paths.
 */
const FINISH_REASON_ALIASES: Record<string, string> = {
  stop: "stop",
  end_turn: "stop",
  stop_sequence: "stop",
  length: "length",
  max_tokens: "length",
  model_length: "length",
  "content-filter": "content-filter",
  content_filter: "content-filter",
  "tool-calls": "tool-calls",
  tool_calls: "tool-calls",
  tool_use: "tool-calls",
  function_call: "tool-calls",
  error: "error",
  other: "other",
  unknown: "unknown",
};

/**
 * Normalize a raw finish reason to the canonical vocabulary. Returns
 * `undefined` for empty/missing input (never fabricates). Unrecognized
 * non-empty values pass through lowercased — we keep debug fidelity rather
 * than collapsing to "other"; only the badge-relevant values are guaranteed
 * canonical. Apply at the write site (see feedback_normalize_at_write_site).
 */
export function normalizeFinishReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const key = trimmed.toLowerCase();
  return FINISH_REASON_ALIASES[key] ?? key;
}

/**
 * Mapping from internal span field → OpenTelemetry semantic-convention
 * attribute name. The seam a future OTLP exporter consumes; nothing in this
 * PR serializes. Verified against the live spec 2026-06-18.
 *
 * Conversions the exporter must apply:
 * - `finishReason` → `gen_ai.response.finish_reasons` is a string[]; emit `[finishReason]` (n=1 per span).
 * - `ttfcMs` → `gen_ai.response.time_to_first_chunk` is seconds (double); emit `ttfcMs / 1000`.
 * - `responseTimestamp` has no attribute — it informs the span end time.
 */
export const OTEL_ATTR = {
  finishReason: "gen_ai.response.finish_reasons",
  provider: "gen_ai.provider.name",
  responseId: "gen_ai.response.id",
  responseTimestamp: null,
  ttfcMs: "gen_ai.response.time_to_first_chunk",
  modelId: "gen_ai.request.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  // MCP tool-span fields. `rpc.response.status_code` is a string at export →
  // String(mcpErrorCode).
  mcpErrorCode: "rpc.response.status_code",
} as const;

export type PromptTraceSummary = {
  promptIndex: number;
  prompt: string;
  expectedToolCalls: PromptTurnToolCall[];
  actualToolCalls: PromptTurnToolCall[];
  expectedOutput?: string;
  passed: boolean;
  missing: PromptTurnToolCall[];
  unexpected: PromptTurnToolCall[];
  argumentMismatches: Array<{
    expected: PromptTurnToolCall;
    actual: PromptTurnToolCall;
    mismatchedArguments: string[];
  }>;
};

export type EvalTraceWidgetSnapshot = {
  toolCallId: string;
  toolName: string;
  protocol: "mcp-apps" | "openai-apps";
  serverId: string;
  resourceUri?: string;
  toolMetadata: Record<string, unknown>;
  widgetCsp?: Record<string, unknown> | null;
  widgetPermissions?: Record<string, unknown> | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  widgetHtmlBlobId?: string;
  widgetHtmlUrl?: string | null;
  /**
   * Whether the OpenAI Apps SDK `window.openai` shim was injected into
   * `widgetHtml` at capture time. Persisted so replay can render the
   * blob faithfully under a different host config without rewriting
   * the bytes — see `MCPAppsRenderer.injectedOpenAiCompat`.
   */
  injectedOpenAiCompat?: boolean;
  /**
   * Per-method `window.openai.*` capability surface the runtime was
   * configured with at capture time. Stored as the full resolved
   * record (not a hash) so debug/replay summaries can render the diff
   * vs. preset and answer "which surface was injected", not just
   * "shim was injected: yes/no". See plan §6.5 +
   * feedback_capability_in_render_recipe memory.
   *
   * Optional / absent for snapshots captured before the matrix
   * shipped — replay treats those as the full ChatGPT surface (the
   * runtime's pre-matrix default).
   */
  injectedOpenAiCompatCapabilities?: {
    callTool?: boolean;
    sendFollowUpMessage?: boolean;
    setWidgetState?: boolean;
    requestDisplayMode?: "all" | "fullscreen-only" | "none";
    notifyIntrinsicHeight?: boolean;
    openExternal?: boolean;
    setOpenInAppUrl?: boolean;
    requestModal?: boolean;
    uploadFile?: boolean;
    selectFiles?: boolean;
    getFileDownloadUrl?: boolean;
    requestCheckout?: boolean;
    requestClose?: boolean;
  };
};

// PR 6b: browser-rendered MCP App eval — render observations + interaction
// steps. Runner records carry base64 screenshots until `finalizeEvalIteration`
// uploads them via `chatSessions:generateSnapshotUploadUrl`; serialized records
// replace that field with `screenshotBlobId`. These never enter
// `EvalTraceBlobV1` — they fan out to the sibling `widgetRenderObservations` /
// `browserInteractionSteps` Convex tables via `appendEvalTurnTrace`, which has
// its own server-side validators, so no Zod mirror lives here.

export type EvalTraceWidgetRenderStatus =
  | "rendered"
  | "no_ui_resource"
  | "resource_read_failed"
  | "mount_failed"
  | "bridge_timeout"
  | "render_error"
  | "blank_screenshot"
  | "screenshot_failed"
  | "browser_unavailable";

export type EvalTraceBrowserAction =
  | "screenshot"
  | "left_click"
  | "double_click"
  | "right_click"
  | "mouse_move"
  | "type"
  | "key"
  | "scroll"
  | "wait";

export type EvalTraceBrowserStepNote =
  | "no_rendered_widget"
  | "step_budget_exceeded"
  | "screenshot_budget_exceeded";

const EVAL_TRACE_BROWSER_STEP_NOTES: ReadonlySet<string> = new Set([
  "no_rendered_widget",
  "step_budget_exceeded",
  "screenshot_budget_exceeded",
]);

/**
 * The harness types `BrowserActionResult.note` as an open `string`, but the
 * backend step validator is a CLOSED union and rejects the whole turn write on
 * an unknown literal. The runner narrows through this guard so a future harness
 * note can never cost an entire turn's worth of steps — keep the step, drop the
 * unrecognized note.
 */
export function isEvalTraceBrowserStepNote(
  value: unknown,
): value is EvalTraceBrowserStepNote {
  return typeof value === "string" && EVAL_TRACE_BROWSER_STEP_NOTES.has(value);
}

export type EvalTraceWidgetToolCall = {
  name: string;
  args: unknown; // sanitized at the boundary; sanitizer handles `$`-keys
  ok: boolean;
  error?: string;
  elapsedMs: number;
};

/**
 * Runner-local render observation: carries `promptIndex` (stamped by the runner)
 * plus the transient base64 screenshot until finalize uploads it.
 */
export type RunnerWidgetRenderObservation = {
  toolCallId: string;
  toolName: string;
  serverId: string; // friendly MCP server name; backend resolves to Id<'servers'>
  status: EvalTraceWidgetRenderStatus;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  screenshotBase64?: string; // transient; uploaded in finalizeEvalIteration
  consoleErrors?: string[];
  blockedRequests?: string[];
  elapsedMs: number;
  ts: number;
  promptIndex: number; // stamped by the runner
};

/**
 * Runner-local interaction step: carries `promptIndex` + `stepIndex` (both
 * stamped by the runner) plus the transient base64 screenshot until finalize
 * uploads it.
 */
export type RunnerBrowserInteractionStep = {
  toolCallId: string;
  stepIndex: number; // monotonic per (toolCallId), stamped by the runner
  promptIndex: number; // stamped by the runner
  action: EvalTraceBrowserAction;
  coordinateX?: number;
  coordinateY?: number;
  text?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
  screenshotBase64?: string; // transient; uploaded in finalizeEvalIteration
  widgetToolCalls?: EvalTraceWidgetToolCall[];
  elapsedMs: number;
  note?: EvalTraceBrowserStepNote;
  ts: number;
};

/**
 * Serialized render observation: screenshot already uploaded
 * (`screenshotBase64` → `screenshotBlobId`), `promptIndex` retained so the W2
 * fanout can bucket per turn.
 */
export type SerializedWidgetRenderObservation = Omit<
  RunnerWidgetRenderObservation,
  "screenshotBase64"
> & {
  screenshotBlobId?: string;
};

/** Serialized interaction step — same screenshot-upload swap as above. */
export type SerializedBrowserInteractionStep = Omit<
  RunnerBrowserInteractionStep,
  "screenshotBase64"
> & {
  screenshotBlobId?: string;
};

// Payloads sent inside one `appendEvalTurnTrace` turn. These deliberately OMIT
// `promptIndex`: the backend stamps it from `turn.promptIndex` server-side.
export type WidgetRenderObservationPayload = Omit<
  SerializedWidgetRenderObservation,
  "promptIndex"
>;

export type BrowserInteractionStepPayload = Omit<
  SerializedBrowserInteractionStep,
  "promptIndex"
>;

// PR 7: shapes the backend trace envelope returns to the replay UI. The
// backend (`getEvalTraceFromChatSession` + `addBrowserArtifactUrls`) collects
// the PR 6b tables, keeps `promptIndex`, and resolves `screenshotBlobId` →
// `screenshotUrl` (null when no blob). `serverId` arrives as the resolved
// Convex doc id; the UI keys on `toolName` / `toolCallId` for display.

export type EvalTraceWidgetRenderObservationView = {
  toolCallId: string;
  toolName: string;
  serverId?: string;
  promptIndex: number;
  status: EvalTraceWidgetRenderStatus;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  screenshotBlobId?: string;
  screenshotUrl?: string | null;
  consoleErrors?: string[];
  blockedRequests?: string[];
  elapsedMs: number;
  ts: number;
};

export type EvalTraceBrowserInteractionStepView = {
  toolCallId: string;
  stepIndex: number;
  promptIndex: number;
  action: EvalTraceBrowserAction;
  coordinateX?: number;
  coordinateY?: number;
  text?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
  screenshotBlobId?: string;
  screenshotUrl?: string | null;
  widgetToolCalls?: EvalTraceWidgetToolCall[];
  elapsedMs: number;
  note?: EvalTraceBrowserStepNote;
  ts: number;
};

/** Versioned blob written by `testSuites:updateTestIteration` when messages are stored. */
export type EvalTraceBlobV1 = {
  traceVersion: 1;
  messages: ModelMessage[];
  widgetSnapshots?: EvalTraceWidgetSnapshot[];
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
};

/** Zod mirror of Convex `traceSpanValidator` for client/server tests and optional runtime checks. */
export const evalTraceSpanZ = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string(),
  category: z.enum(["step", "llm", "tool", "error"]),
  startMs: z.number(),
  endMs: z.number(),
  promptIndex: z.number().optional(),
  stepIndex: z.number().optional(),
  status: z.enum(["ok", "error"]).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  serverId: z.string().optional(),
  modelId: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  messageStartIndex: z.number().optional(),
  messageEndIndex: z.number().optional(),
  // GenAI harness metadata — see EvalTraceSpan + OTEL_ATTR.
  finishReason: z.string().optional(),
  provider: z.string().optional(),
  responseId: z.string().optional(),
  responseTimestamp: z.string().optional(),
  ttfcMs: z.number().optional(),
  // MCP server-contract metadata (tool spans).
  mcpErrorCode: z.number().optional(),
});

const traceToolCallZ = z.object({
  toolName: z.string(),
  arguments: z.record(z.string(), z.any()),
});

const promptTraceSummaryZ = z.object({
  promptIndex: z.number(),
  prompt: z.string(),
  expectedToolCalls: z.array(traceToolCallZ),
  actualToolCalls: z.array(traceToolCallZ),
  expectedOutput: z.string().optional(),
  passed: z.boolean(),
  missing: z.array(traceToolCallZ),
  unexpected: z.array(traceToolCallZ),
  argumentMismatches: z.array(
    z.object({
      expected: traceToolCallZ,
      actual: traceToolCallZ,
      mismatchedArguments: z.array(z.string()),
    }),
  ),
});

const evalTraceWidgetSnapshotZ = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  protocol: z.union([z.literal("mcp-apps"), z.literal("openai-apps")]),
  serverId: z.string(),
  resourceUri: z.string().optional(),
  toolMetadata: z.record(z.string(), z.unknown()),
  widgetCsp: z.record(z.string(), z.unknown()).nullable().optional(),
  widgetPermissions: z.record(z.string(), z.unknown()).nullable().optional(),
  widgetPermissive: z.boolean().optional(),
  prefersBorder: z.boolean().optional(),
  widgetHtmlBlobId: z.string().optional(),
  widgetHtmlUrl: z.string().nullable().optional(),
  injectedOpenAiCompat: z.boolean().optional(),
  // Mirror of `EvalTraceWidgetSnapshot.injectedOpenAiCompatCapabilities`.
  // Sparse object — every field optional — matching what the SDK
  // runtime actually consumed. Strict per-field validation keeps
  // hand-edited eval blobs from injecting unknown method flags.
  injectedOpenAiCompatCapabilities: z
    .object({
      callTool: z.boolean().optional(),
      sendFollowUpMessage: z.boolean().optional(),
      setWidgetState: z.boolean().optional(),
      requestDisplayMode: z.enum(["all", "fullscreen-only", "none"]).optional(),
      notifyIntrinsicHeight: z.boolean().optional(),
      openExternal: z.boolean().optional(),
      setOpenInAppUrl: z.boolean().optional(),
      requestModal: z.boolean().optional(),
      uploadFile: z.boolean().optional(),
      selectFiles: z.boolean().optional(),
      getFileDownloadUrl: z.boolean().optional(),
      requestCheckout: z.boolean().optional(),
      requestClose: z.boolean().optional(),
    })
    .optional(),
});

export const evalTraceBlobV1Z = z.object({
  traceVersion: z.literal(1),
  messages: z.array(z.any()),
  widgetSnapshots: z.array(evalTraceWidgetSnapshotZ).optional(),
  spans: z.array(evalTraceSpanZ).optional(),
  prompts: z.array(promptTraceSummaryZ).optional(),
});

export function msOffsetFromRunStart(
  runStartedAt: number,
  absoluteMs: number,
): number {
  return absoluteMs - runStartedAt;
}

export function normalizeSpanInterval(
  startMs: number,
  endMs: number,
): { startMs: number; endMs: number } {
  if (endMs <= startMs) return { startMs, endMs: startMs + 1 };
  return { startMs, endMs };
}

export function createOffsetInterval(
  runStartedAt: number,
  startAbs: number,
  endAbs: number,
): { startMs: number; endMs: number } {
  return normalizeSpanInterval(
    msOffsetFromRunStart(runStartedAt, startAbs),
    msOffsetFromRunStart(runStartedAt, endAbs),
  );
}

function messageDedupeKey(message: ModelMessage): string {
  const id = (message as { id?: string }).id;
  if (typeof id === "string" && id) return `id:${id}`;
  try {
    return `json:${JSON.stringify(message)}`;
  } catch {
    return `fallthrough:${String((message as { role?: string }).role)}`;
  }
}

/** Append `incoming` to `acc`, skipping duplicates (by `id` or JSON identity). */
export function appendDedupedModelMessages(
  acc: ModelMessage[],
  incoming: ModelMessage[],
): void {
  const seen = new Set(acc.map(messageDedupeKey));
  for (const m of incoming) {
    const key = messageDedupeKey(m);
    if (!seen.has(key)) {
      seen.add(key);
      acc.push(m);
    }
  }
}

export function stepResultHasToolActivity(step: {
  toolCalls?: unknown[] | null;
  dynamicToolCalls?: unknown[] | null;
  staticToolCalls?: unknown[] | null;
  toolResults?: unknown[] | null;
  staticToolResults?: unknown[] | null;
  dynamicToolResults?: unknown[] | null;
}): boolean {
  const arrays = [
    step.toolCalls,
    step.dynamicToolCalls,
    step.staticToolCalls,
    step.toolResults,
    step.staticToolResults,
    step.dynamicToolResults,
  ];
  return arrays.some((a) => Array.isArray(a) && a.length > 0);
}
