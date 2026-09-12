/**
 * Executing ONE MCPJam UI tool call, for whoever asked.
 *
 * The seam between the two agents that can reach the `ui_*` catalog and the
 * handlers themselves:
 *   - Ask MCPJam, through `ui-tool-executor.ts` (approval pill, transcript,
 *     duplicate-call suppression, conversation scope), and
 *   - a browser-native WebMCP agent, through `native-tool-publisher.ts` (the
 *     browser owns that agent's approval flow; there is no conversation).
 *
 * Everything in here is what BOTH must do identically: resolve the name
 * against the registry, validate the arguments, run the registered handler,
 * and hand back a bounded, JSON-serializable result plus a machine-readable
 * status. Everything a single transport does — approvals, transcripts,
 * telemetry, navigation handoff, conversation state — stays in that
 * transport's adapter, which is why neither can quietly grow a second answer
 * to "what does this tool do?".
 *
 * WHAT IT DELIBERATELY DOES NOT DO: retry. A UI tool call can add a server,
 * run a tool against somebody's live MCP server, or spend eval quota, and
 * nothing here knows which failures were side-effect-free. A caller that
 * wants another attempt asks for one.
 */

import { assertEvalToolAllowed } from "@/lib/mcpjam-agent/eval-scope";
import type { InspectorCommandErrorCode } from "@/shared/inspector-command.js";
import { clampText } from "./bounded-size";
import {
  useUiToolsRegistry,
  type UiToolCaller,
  type UiToolResult,
} from "./ui-tools-registry";

/**
 * What happened, in one machine-readable token. Adapters map these onto their
 * own vocabulary (chat telemetry, native diagnostics) rather than re-deriving
 * the outcome from the result text.
 */
export type UiToolExecutionStatus =
  /** The handler ran and reported success. */
  | "ok"
  /** The handler ran and reported failure (`isError`). */
  | "error"
  /** No such tool is registered right now (unmounted, HMR, never existed). */
  | "unavailable"
  /** The arguments were not a JSON object. */
  | "invalid_input"
  /** The caller's signal was already aborted; the handler never ran. */
  | "cancelled"
  /** The handler threw instead of returning a result. */
  | "threw";

export interface UiToolExecutionRequest {
  /** Registry name (`ui_*`). Resolved here, not by the caller. */
  toolName: string;
  /** Raw arguments as the agent sent them. Validated, never trusted. */
  input: unknown;
  /** Which agent is asking. */
  caller: UiToolCaller;
  /**
   * Identity of THIS invocation: the streamed tool-call id for Ask MCPJam, a
   * minted id for a native call. Handed to the tool, which may key parked
   * state on it.
   */
  invocationId: string;
  /**
   * The Ask MCPJam conversation this call belongs to, when there is one. It
   * carries the eval scope and scopes cancellation of parked tools. A native
   * call has no conversation and passes nothing.
   */
  scope?: string;
  /**
   * Cancellation, when the transport has any. Checked before the handler runs
   * and forwarded to it; an abort NEVER un-does work already done.
   */
  signal?: AbortSignal;
}

export interface UiToolExecutionOutcome {
  /** Bounded, JSON-serializable, always present — even for a failure. */
  result: UiToolResult;
  status: UiToolExecutionStatus;
  /**
   * Low-cardinality error code for diagnostics, when one can be established:
   * a structured inspector-command code, or one of this module's own
   * (`tool_unavailable`, `invalid_input`, `tool_threw`, `cancelled`). Never
   * free text — error messages can contain a server's own words.
   */
  errorCode?: string;
}

/**
 * Structured error codes only: the leading `code:` prefix of a command-bus
 * error (see `commandResponseToActionResult`), validated against the CLOSED
 * `InspectorCommandErrorCode` set so a free-text message can never be
 * reported. Unrecognized error texts produce no code at all.
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

export function structuredErrorCode(output: UiToolResult): string | undefined {
  if (!output.isError) return undefined;
  const first = output.content?.[0];
  const text = first?.type === "text" ? first.text : "";
  const code = text.split(":", 1)[0]?.trim();
  return code && INSPECTOR_COMMAND_ERROR_CODES.has(code) ? code : undefined;
}

export function uiToolErrorResult(message: string): UiToolResult {
  return {
    content: [{ type: "text", text: clampText(message) }],
    isError: true,
  };
}

/** The message an unresolvable name gets, identical on both transports. */
export function uiToolUnavailableResult(toolName: string): UiToolResult {
  return uiToolErrorResult(`UI tool "${toolName}" is no longer available.`);
}

/**
 * Arguments as the handlers expect them, or a rejection.
 *
 * A missing or null payload is a legitimate no-argument call (`ui_snapshot_app`
 * takes nothing). Anything else that is not a plain object — a bare string, a
 * number, an array — is a malformed call, and saying so is far more useful
 * than silently substituting `{}` and reporting whichever required field went
 * missing as a result.
 */
function readArguments(
  input: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, args: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: `Arguments must be a JSON object, got ${Array.isArray(input) ? "an array" : `a ${typeof input}`}.`,
    };
  }
  return { ok: true, args: input as Record<string, unknown> };
}

/**
 * Force a handler's return value into the wire shape, bounded.
 *
 * The first-party handlers already return bounded text (`okResult` /
 * `errorResult` in `groups/shared.ts`), so for every tool in the catalog this
 * is a pass-through that rebuilds an equal object. It exists for the value
 * that ISN'T one of those: a future handler returning a foreign shape, a
 * `content` array holding non-text parts, or a string long enough to bloat an
 * agent's context. Both transports serialize what comes back — Ask MCPJam
 * into a transcript, WebMCP across the browser boundary — so neither can
 * accept "whatever the handler felt like returning".
 */
function boundedResult(value: unknown): UiToolResult {
  const source = value as Partial<UiToolResult> | undefined;
  const parts = Array.isArray(source?.content) ? source.content : [];
  const content: UiToolResult["content"] = [];
  for (const part of parts) {
    if (part && typeof part === "object" && part.type === "text") {
      content.push({ type: "text", text: clampText(String(part.text ?? "")) });
      continue;
    }
    // A non-text part still has to cross a JSON boundary; carry what can be
    // serialized and never throw on what can't.
    let text: string;
    try {
      text = JSON.stringify(part) ?? String(part);
    } catch {
      text = "[unserializable tool result part]";
    }
    content.push({ type: "text", text: clampText(text) });
  }
  if (content.length === 0) {
    content.push({
      type: "text",
      text: "The tool returned no content.",
    });
  }
  return source?.isError ? { content, isError: true } : { content };
}

/**
 * The answer for a call the caller abandoned before the handler ran.
 *
 * Worded carefully, and used for every pre-dispatch cancellation check so the
 * wording cannot drift: an abort is not a rollback, and an agent told
 * "cancelled" about work that already happened would act on a false picture
 * of the world.
 */
function cancelledOutcome(toolName: string): UiToolExecutionOutcome {
  return {
    result: uiToolErrorResult(
      `UI tool "${toolName}" was cancelled before it ran; nothing was executed.`,
    ),
    status: "cancelled",
    errorCode: "cancelled",
  };
}

/**
 * Resolve, validate, run.
 *
 * Never throws: every failure — unknown tool, bad arguments, a handler that
 * threw, a call cancelled before it started — comes back as an error result
 * with a status, because both transports owe their caller an answer and a
 * thrown exception would strand a paused stream or a pending native
 * invocation.
 */
export async function executeUiToolCall(
  request: UiToolExecutionRequest,
): Promise<UiToolExecutionOutcome> {
  const { toolName, input, caller, invocationId, scope, signal } = request;

  // Cancellation, before anything is resolved or dispatched.
  if (signal?.aborted) return cancelledOutcome(toolName);

  const def = useUiToolsRegistry.getState().resolve(toolName);
  if (!def) {
    return {
      result: uiToolUnavailableResult(toolName),
      status: "unavailable",
      errorCode: "tool_unavailable",
    };
  }

  const args = readArguments(input);
  if (!args.ok) {
    return {
      result: uiToolErrorResult(`${toolName}: ${args.error}`),
      status: "invalid_input",
      errorCode: "invalid_input",
    };
  }

  // Again between the lookups above and the dispatch below: resolving and
  // validating are the last cheap moments to notice the caller walked away.
  if (signal?.aborted) return cancelledOutcome(toolName);

  let output: UiToolResult;
  try {
    // Eval scope is re-asserted HERE, inside the try, so an out-of-scope call
    // fails like any other handler failure rather than escaping as an
    // exception. Ask MCPJam also gates earlier, before it claims the call;
    // this is the backstop that holds for every transport.
    assertEvalToolAllowed(scope, toolName);
    output = boundedResult(
      await def.execute(args.args, {
        toolCallId: invocationId,
        caller,
        ...(scope !== undefined ? { scope } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  } catch (error) {
    return {
      result: uiToolErrorResult(
        `UI tool failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      ),
      status: "threw",
      errorCode: "tool_threw",
    };
  }

  // Deliberately NOT re-checked against `signal` here. The handler ran; a
  // late abort does not un-navigate a page or un-run a tool.
  if (!output.isError) return { result: output, status: "ok" };
  const errorCode = structuredErrorCode(output);
  return {
    result: output,
    status: "error",
    ...(errorCode ? { errorCode } : {}),
  };
}
