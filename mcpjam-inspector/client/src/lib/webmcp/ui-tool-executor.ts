/**
 * Client-side fulfillment for WebMCP UI tool calls streamed back by the
 * server (which registered them as no-execute AI SDK tools).
 *
 * Called first from each chat surface's `useChat.onToolCall`; returns `false`
 * for names that aren't ours so the app-tool and server-tool paths run
 * unchanged. Dispatch is gated on registry membership / the per-session
 * shipped-name set — never the `ui_` prefix alone — so a genuine server tool
 * named `ui_something` falls through untouched.
 *
 * Approval (`requireToolApproval`): the AI SDK fires `onToolCall` on
 * `tool-input-available`, BEFORE the server's `tool-approval-request` chunk
 * reaches the client — so when the flag is on, mutating UI tool calls are
 * DEFERRED here (claimed, but not executed) and resolved by the approval
 * pill: Approve executes via `fulfillApprovedUiToolCall` and ships the
 * result (never a bare approval response — the server cannot execute a
 * no-execute tool); Deny sends the normal approval response. The
 * client/server gate must agree, so both read the shared
 * `uiToolCallNeedsApproval`.
 */

import { uiToolCallNeedsApproval } from "@/shared/client-fulfilled-tools.js";
import type { InspectorCommandErrorCode } from "@/shared/inspector-command.js";
import { track } from "@/lib/analytics";
import { pathnameToActiveTab } from "@/lib/app-navigation";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
  type UiToolResult,
} from "./ui-tools-registry";

export interface HandleUiToolCallOptions {
  toolName: string;
  toolCallId: string;
  input: unknown;
  addToolOutput: (output: {
    tool: string;
    toolCallId: string;
    output: UiToolResult;
  }) => void;
  /**
   * Fired BEFORE `execute` when the resolved tool is flagged `mayNavigate` —
   * the seam where a route-bound surface hands the conversation off to the
   * side panel before the route commits. Best-effort: a throwing callback
   * must never block the tool output (the stream would hang).
   */
  onNavigationToolCall?: (toolName: string) => void;
  /** The turn's approval flag — defers mutating tools to the approval pill. */
  requireToolApproval?: boolean;
  /**
   * Duplicate-detection scope, normally the caller's chatSessionId. Calls
   * with the same scope share one signature ring; omitting it falls back to
   * a shared "default" ring.
   */
  telemetryScope?: string;
}

/**
 * Tool calls already executed (or executing). The server can legitimately
 * re-emit `tool-input-available` for a call that already ran (its
 * approval-resume path re-fires client `onToolCall`), and the pill's
 * Approve button can race a double-click — neither may double-execute a
 * side-effectful tool like `ui_execute_tool`.
 */
const settledOrInFlightToolCallIds = new Set<string>();

/** Calls claimed-but-deferred, awaiting the user's approval. */
const deferredUiToolCalls = new Map<
  string,
  { toolName: string; input: unknown; telemetryScope?: string }
>();

export function __resetUiToolExecutorForTests(): void {
  settledOrInFlightToolCallIds.clear();
  deferredUiToolCalls.clear();
  telemetryByToolCallId.clear();
  recentCallSignaturesByScope.clear();
}

// --- Outcome telemetry ------------------------------------------------
//
// Observation-only: every emit is wrapped so a throwing analytics call can
// never break tool fulfillment (a lost output would hang the stream). HARD
// RULE: event properties are names/booleans/counts/durations only — never
// tool args, tool outputs, or free-text messages. Duplicate detection
// hashes args into an in-memory signature that never leaves this module.

type UiToolCallOutcome = "success" | "error" | "denied";
type UiToolCallApproval = "not_required" | "approved" | "denied";

interface UiToolCallTelemetry {
  toolName: string;
  surfaceId: string;
  startedAt: number;
  duplicateOfPrevious: boolean;
  callsSinceDuplicate?: number;
}

/** Started-time facts carried to the (possibly much later) completed emit. */
const telemetryByToolCallId = new Map<string, UiToolCallTelemetry>();

/**
 * Last N call signatures PER CHAT SESSION, oldest first, for duplicate-call
 * detection (a looping agent re-issuing the same call). Scoped by the
 * caller's `telemetryScope` (its chatSessionId) because this executor serves
 * both the regular chat session and the MCPJam-agent chat — a shared ring
 * would report cross-session false duplicates. Signatures include
 * canonicalized args and therefore NEVER leave this module — only the
 * duplicate boolean and the call distance are emitted.
 */
const RECENT_SIGNATURE_LIMIT = 20;
const SIGNATURE_SCOPE_LIMIT = 8;
const recentCallSignaturesByScope = new Map<string, string[]>();

function signatureRingFor(scope: string): string[] {
  let ring = recentCallSignaturesByScope.get(scope);
  if (!ring) {
    ring = [];
    // Bound total memory: evict the oldest scope (Map preserves insertion
    // order) once defunct sessions accumulate.
    if (recentCallSignaturesByScope.size >= SIGNATURE_SCOPE_LIMIT) {
      const oldest = recentCallSignaturesByScope.keys().next().value;
      if (oldest !== undefined) recentCallSignaturesByScope.delete(oldest);
    }
    recentCallSignaturesByScope.set(scope, ring);
  }
  return ring;
}

function emitTelemetry(
  event: "ui_tool_call_started" | "ui_tool_call_completed",
  props: Record<string, unknown>,
): void {
  try {
    track(event, { location: "webmcp", ...props });
  } catch {
    // Telemetry must never break tool execution.
  }
}

/** Recursively sort object keys so equal args always hash equal. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

function callSignature(toolName: string, input: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(canonicalize(input))}`;
  } catch {
    return `${toolName}:<unserializable>`;
  }
}

/** Low-cardinality app segment for the surface the call ran against. */
function currentSurfaceId(): string {
  try {
    if (typeof window === "undefined") return "unknown";
    return pathnameToActiveTab(window.location.pathname);
  } catch {
    return "unknown";
  }
}

function beginUiToolCallTelemetry(opts: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  needsApproval: boolean;
  telemetryScope?: string;
}): void {
  const ring = signatureRingFor(opts.telemetryScope ?? "default");
  const signature = callSignature(opts.toolName, opts.input);
  const matchIndex = ring.lastIndexOf(signature);
  const duplicateOfPrevious = matchIndex >= 0;
  // Distance measured BEFORE the push mutates indices: 1 = previous call.
  const callsSinceDuplicate = duplicateOfPrevious
    ? ring.length - matchIndex
    : undefined;
  ring.push(signature);
  if (ring.length > RECENT_SIGNATURE_LIMIT) {
    ring.shift();
  }
  const entry: UiToolCallTelemetry = {
    toolName: opts.toolName,
    surfaceId: currentSurfaceId(),
    startedAt: Date.now(),
    duplicateOfPrevious,
    ...(callsSinceDuplicate !== undefined ? { callsSinceDuplicate } : {}),
  };
  telemetryByToolCallId.set(opts.toolCallId, entry);
  emitTelemetry("ui_tool_call_started", {
    tool_name: entry.toolName,
    surface_id: entry.surfaceId,
    needs_approval: opts.needsApproval,
  });
}

function completeUiToolCallTelemetry(
  toolCallId: string,
  outcome: UiToolCallOutcome,
  approval: UiToolCallApproval,
  errorCode?: string,
): void {
  const entry = telemetryByToolCallId.get(toolCallId);
  // No started entry (e.g. a deny after reload, where the defer happened in
  // a previous page load): skip rather than emit an unpaired completed.
  if (!entry) return;
  telemetryByToolCallId.delete(toolCallId);
  emitTelemetry("ui_tool_call_completed", {
    tool_name: entry.toolName,
    surface_id: entry.surfaceId,
    duration_ms: Date.now() - entry.startedAt,
    outcome,
    ...(errorCode ? { error_code: errorCode } : {}),
    approval,
    duplicate_of_previous: entry.duplicateOfPrevious,
    ...(entry.callsSinceDuplicate !== undefined
      ? { calls_since_duplicate: entry.callsSinceDuplicate }
      : {}),
  });
}

/**
 * Structured error codes only: the leading `code:` prefix of a command-bus
 * error (see `commandResponseToActionResult`), validated against the CLOSED
 * `InspectorCommandErrorCode` set so a free-text message can never be
 * emitted. Unrecognized error texts emit no code at all.
 */
const INSPECTOR_COMMAND_ERROR_CODES = new Set<string>([
  "no_active_client",
  "unknown_server",
  "disconnected_server",
  "unknown_tool",
  "unknown_command_id",
  "timeout",
  "unsupported_in_mode",
  "invalid_request",
  "execution_failed",
] satisfies InspectorCommandErrorCode[]);

function structuredErrorCode(output: UiToolResult): string | undefined {
  if (!output.isError) return undefined;
  const first = output.content?.[0];
  const text = first?.type === "text" ? first.text : "";
  const code = text.split(":", 1)[0]?.trim();
  return code && INSPECTOR_COMMAND_ERROR_CODES.has(code) ? code : undefined;
}
// --- End outcome telemetry ---------------------------------------------

/** Deferred calls, for the orphaned-defer fallback (see ui-tool-approval). */
export function listDeferredUiToolCalls(): Array<{
  toolCallId: string;
  toolName: string;
  input: unknown;
  telemetryScope?: string;
}> {
  return [...deferredUiToolCalls.entries()].map(([toolCallId, v]) => ({
    toolCallId,
    ...v,
  }));
}

/**
 * Settle a call the user DENIED: the server's denial machinery supplies the
 * result, so the call must become unfulfillable here — otherwise a duplicate
 * approve event (double-emitted pill handlers, replayed state) could still
 * execute a side-effectful tool the user explicitly rejected.
 */
export function settleDeniedUiToolCall(
  toolCallId: string,
  meta?: { toolName?: string; input?: unknown; telemetryScope?: string },
): void {
  settledOrInFlightToolCallIds.add(toolCallId);
  const stashed = deferredUiToolCalls.get(toolCallId);
  deferredUiToolCalls.delete(toolCallId);
  // Reload-then-deny: the defer (and its started event) happened in a
  // previous page load, so no in-memory entry exists. The approval part's
  // persisted metadata lets us establish the lifecycle here so denied calls
  // are not silently absent from outcome telemetry.
  const toolName = meta?.toolName ?? stashed?.toolName;
  if (!telemetryByToolCallId.has(toolCallId) && toolName) {
    beginUiToolCallTelemetry({
      toolCallId,
      toolName,
      input: meta?.input !== undefined ? meta.input : stashed?.input,
      needsApproval: true,
      telemetryScope: meta?.telemetryScope ?? stashed?.telemetryScope,
    });
  }
  // Denied approvals are terminal for the client: exactly one completed
  // event, outcome "denied" (the server synthesizes the denial result).
  completeUiToolCallTelemetry(toolCallId, "denied", "denied");
}

async function executeResolvedUiTool(
  def: UiToolDefinition,
  opts: Pick<
    HandleUiToolCallOptions,
    "toolName" | "toolCallId" | "input" | "addToolOutput"
  >,
  approval: UiToolCallApproval,
): Promise<void> {
  const { toolName, toolCallId, input, addToolOutput } = opts;
  settledOrInFlightToolCallIds.add(toolCallId);
  deferredUiToolCalls.delete(toolCallId);
  let output: UiToolResult;
  let threw = false;
  try {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    output = await def.execute(args);
  } catch (error) {
    threw = true;
    output = {
      content: [
        {
          type: "text",
          text: `UI tool failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        },
      ],
      isError: true,
    };
  }
  addToolOutput({ tool: toolName, toolCallId, output });
  completeUiToolCallTelemetry(
    toolCallId,
    output.isError ? "error" : "success",
    approval,
    threw ? "tool_threw" : structuredErrorCode(output),
  );
}

function unavailableOutput(toolName: string): UiToolResult {
  return {
    content: [
      {
        type: "text",
        text: `UI tool "${toolName}" is no longer available.`,
      },
    ],
    isError: true,
  };
}

/**
 * Returns `true` when the call was ours and was either resolved (output
 * supplied) or deferred to the approval pill; `false` when the name doesn't
 * belong to the UI tool layer and the caller should fall through to its
 * other handlers.
 */
export async function handleUiToolCall(
  opts: HandleUiToolCallOptions,
): Promise<boolean> {
  const { toolName, toolCallId, input, addToolOutput } = opts;
  const registry = useUiToolsRegistry.getState();
  const def = registry.resolve(toolName);

  // Re-emission of an already-executed call (approval-resume re-fires
  // onToolCall): claimed, output already in the transcript — do nothing.
  // Checked BEFORE the unavailable branch so a settled call whose tool has
  // since unregistered (HMR/unmount) can't send a second output or inflate
  // telemetry with a duplicate started/completed pair. Only IDs this module
  // executed are ever in the set, so claiming here is always ours to claim.
  if (settledOrInFlightToolCallIds.has(toolCallId)) return true;
  // Same idempotency for a call that is still parked awaiting approval: a
  // re-emitted deferred call is claimed but must not re-begin telemetry or
  // re-stash.
  if (deferredUiToolCalls.has(toolCallId)) return true;

  if (!def) {
    // The name was advertised to the server in an earlier snapshot but the
    // tool is gone (HMR teardown, unmount). An output MUST still be
    // supplied or the paused server stream waits forever — same rule as
    // closed app iframes in the app-tool path.
    if (registry.wasShipped(toolName)) {
      beginUiToolCallTelemetry({
        toolCallId,
        toolName,
        input,
        needsApproval: false,
        telemetryScope: opts.telemetryScope,
      });
      addToolOutput({
        tool: toolName,
        toolCallId,
        output: unavailableOutput(toolName),
      });
      completeUiToolCallTelemetry(
        toolCallId,
        "error",
        "not_required",
        "tool_unavailable",
      );
      return true;
    }
    return false;
  }

  const needsApproval = uiToolCallNeedsApproval({
    readOnly: def.readOnly,
    annotations: def.annotations,
    requireToolApproval: opts.requireToolApproval === true,
  });
  beginUiToolCallTelemetry({
    toolCallId,
    toolName,
    input,
    needsApproval,
    telemetryScope: opts.telemetryScope,
  });

  if (needsApproval) {
    deferredUiToolCalls.set(toolCallId, {
      toolName,
      input,
      telemetryScope: opts.telemetryScope,
    });
    return true;
  }

  if (def.mayNavigate) {
    try {
      // Tolerate async callbacks too: a rejection must not surface as an
      // unhandled promise rejection (the contract is fire-and-forget).
      void Promise.resolve(opts.onNavigationToolCall?.(toolName)).catch(
        () => {},
      );
    } catch {
      // Handoff is best-effort; the tool output must still be delivered.
    }
  }

  await executeResolvedUiTool(
    def,
    { toolName, toolCallId, input, addToolOutput },
    "not_required",
  );
  return true;
}

/**
 * Execute a UI tool call the user just APPROVED (or one whose approval
 * request never arrived — the orphaned-defer fallback). `toolName`/`input`
 * fall back to the deferred stash, and callers pass the part's own values
 * for the reload case where the stash is gone.
 */
export async function fulfillApprovedUiToolCall(opts: {
  toolCallId: string;
  toolName?: string;
  input?: unknown;
  addToolOutput: HandleUiToolCallOptions["addToolOutput"];
  onNavigationToolCall?: (toolName: string) => void;
  /** Duplicate-detection scope; falls back to the deferred stash's scope. */
  telemetryScope?: string;
}): Promise<void> {
  const { toolCallId, addToolOutput } = opts;
  if (settledOrInFlightToolCallIds.has(toolCallId)) return;
  const stashed = deferredUiToolCalls.get(toolCallId);
  const toolName = opts.toolName ?? stashed?.toolName;
  if (!toolName) return;
  const input = opts.input !== undefined ? opts.input : stashed?.input;

  // Reload case: the defer (and its started event) happened in a previous
  // page load, so this execution attempt is where handling begins here.
  if (!telemetryByToolCallId.has(toolCallId)) {
    beginUiToolCallTelemetry({
      toolCallId,
      toolName,
      input,
      needsApproval: true,
      telemetryScope: opts.telemetryScope ?? stashed?.telemetryScope,
    });
  }

  const registry = useUiToolsRegistry.getState();
  const def = registry.resolve(toolName);
  if (!def) {
    settledOrInFlightToolCallIds.add(toolCallId);
    deferredUiToolCalls.delete(toolCallId);
    addToolOutput({
      tool: toolName,
      toolCallId,
      output: unavailableOutput(toolName),
    });
    completeUiToolCallTelemetry(
      toolCallId,
      "error",
      "approved",
      "tool_unavailable",
    );
    return;
  }

  if (def.mayNavigate) {
    try {
      // Best-effort, same as the un-gated path (async rejections included).
      void Promise.resolve(opts.onNavigationToolCall?.(toolName)).catch(
        () => {},
      );
    } catch {
      // Best-effort, same as the un-gated path.
    }
  }

  await executeResolvedUiTool(
    def,
    { toolName, toolCallId, input, addToolOutput },
    "approved",
  );
}
