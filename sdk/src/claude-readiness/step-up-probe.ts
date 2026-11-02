import {
  dialInitialize,
  dialToolCall,
  dialToolListing,
} from "../directory-readiness/mcp-dial.js";
import {
  assertArmed,
  ClaudeIntrusiveMode,
  ClaudeIntrusiveObservations,
} from "./intrusive.js";

export interface ClaudeStepUpProbeOptions {
  /** The connector URL exactly as entered. */
  enteredUrl: string;
  fetchFn: typeof fetch;
  /**
   * The caller's credential for the MCP endpoint: an access token that LACKS
   * the scope `protectedToolName` needs, as a header map (normally just
   * `authorization`). Sent only to the endpoint, exactly as the dial sends it.
   */
  mcpHeaders: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Call the declared tool once with a token that lacks its scope, and record
 * whether the server challenged for the step-up.
 *
 * Refuses, without calling anything, a tool that is not listed or not
 * annotated `readOnlyHint: true`: the gate's "nothing else may be called" is
 * about WHICH tool, and this adds "and only if it says it changes nothing".
 */
export async function probeStepUpChallenge(
  mode: Extract<ClaudeIntrusiveMode, { enabled: true }>,
  options: ClaudeStepUpProbeOptions,
): Promise<NonNullable<ClaudeIntrusiveObservations["stepUp"]>> {
  assertArmed(mode);
  const toolName = mode.protectedToolName;
  if (!toolName) {
    return {
      attempted: false,
      toolName: "",
      status: 0,
      error: "no `protectedToolName` was declared",
    };
  }
  if (Object.keys(options.mcpHeaders).length === 0) {
    return {
      attempted: false,
      toolName,
      status: 0,
      error:
        "the step-up probe needs an access token that lacks the tool's scope, and none was supplied",
    };
  }

  const dial = {
    enteredUrl: options.enteredUrl,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    mcpHeaders: options.mcpHeaders,
  };
  const initialize = await dialInitialize(dial);
  if (!initialize.ok) {
    return {
      attempted: false,
      toolName,
      status: initialize.status ?? 0,
      error: `an initialize with the supplied token failed (${
        initialize.error ?? "no result"
      }), so the tool was not called`,
    };
  }
  const listing = await dialToolListing(dial, initialize.sessionId);
  const tool = listing.entries.find((entry) => entry.name === toolName);
  if (!tool) {
    return {
      attempted: false,
      toolName,
      status: 0,
      error: `no tool named "${toolName}" was listed to the supplied token, so it was not called`,
    };
  }
  if (tool.annotations?.readOnlyHint !== true) {
    return {
      attempted: false,
      toolName,
      status: 0,
      error: `"${toolName}" is not annotated readOnlyHint: true; the step-up probe calls read-only tools only`,
    };
  }

  const call = await dialToolCall(dial, toolName, initialize.sessionId, 950);
  if (call.unreachable) {
    return {
      attempted: false,
      toolName,
      status: 0,
      error: call.error ?? "the tool call could not be reached",
    };
  }
  return {
    attempted: true,
    toolName,
    status: call.status ?? 0,
    ...(call.wwwAuthenticate !== undefined
      ? { wwwAuthenticate: call.wwwAuthenticate }
      : {}),
    ...(call.error ? { error: call.error } : {}),
  };
}
