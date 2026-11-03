import {
  DirectoryDialOptions,
  asRecord,
  asString,
  callJsonRpc,
  readChallengeHeader,
} from "./mcp-dial.js";

/**
 * What one `tools/call` answered, reduced to what readiness reads.
 *
 * The tool's CONTENT is deliberately absent. Readiness grades how a server
 * refuses or serves a call, never what the tool returned, and a result body
 * kept as evidence would be one more place a server's data could be persisted
 * and shared with a report.
 */
export interface DirectoryToolCallEvidence {
  /** HTTP status. Absent when nothing answered. */
  status?: number;
  /** `WWW-Authenticate` on the response, verbatim and capped. */
  wwwAuthenticate?: string;
  /**
   * The JSON-RPC result's `isError` and `_meta`, when the server answered with
   * a result. `_meta` is what a tool-level sign-in challenge rides in.
   */
  result?: { isError: boolean; _meta?: Record<string, unknown> };
  /** A JSON-RPC error the server answered with instead of a result. */
  rpcError?: { code?: number; message?: string };
  /**
   * The server rejected the call's ARGUMENTS: a JSON-RPC `-32602`, or an
   * `isError` result whose text reports an input-validation failure. Such a
   * refusal comes before any decision about authorization, so it says
   * nothing about sign-in. Only the flag is kept, never the server's text.
   */
  invalidArguments?: true;
  /** Nothing readable answered: a transport failure or a bodyless non-error. */
  unreachable?: boolean;
  error?: string;
}

/** An input-validation failure as MCP servers commonly word it. */
export const INPUT_VALIDATION_TEXT =
  /\binput validation\b|\binvalid (?:arguments|params|parameters|input)\b|-32602/i;

export function reportsInputValidation(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    const block = asRecord(item);
    const text = block?.type === "text" ? asString(block.text) : undefined;
    return (
      text !== undefined && INPUT_VALIDATION_TEXT.test(text.slice(0, 1024))
    );
  });
}

/**
 * Call one tool, once, and record how the server answered.
 *
 * THE CALLER CHOOSES THE TOOL AND THE CREDENTIAL. This function adds no
 * policy of its own: it sends exactly the `mcpHeaders` in `options`, which is
 * none at all for an unauthenticated probe, and the caller is responsible for
 * calling only a tool it has established is safe to call. Every readiness
 * caller restricts itself to tools annotated `readOnlyHint: true`.
 *
 * Arguments default to `{}`. A probe that invented arguments would be calling
 * a different operation from the one it was asked to observe.
 */
export async function dialToolCall(
  options: DirectoryDialOptions,
  toolName: string,
  sessionId?: string,
  id = 900,
  args: Record<string, unknown> = {},
): Promise<DirectoryToolCallEvidence> {
  const call = await callJsonRpc(
    options,
    id,
    "tools/call",
    { name: toolName, arguments: args },
    sessionId ? { "mcp-session-id": sessionId } : undefined,
  );
  const wwwAuthenticate = readChallengeHeader(call.headers);
  const base: DirectoryToolCallEvidence = {
    ...(call.status ? { status: call.status } : {}),
    ...(wwwAuthenticate !== undefined ? { wwwAuthenticate } : {}),
  };

  if (!call.document) {
    // A refusal needs no body: a bare 401 is a complete answer, and calling
    // it unreachable would turn the one signal a probe looks for into a gap.
    if (call.status && call.status >= 400) {
      return {
        ...base,
        error: call.transportError ?? `tools/call answered ${call.status}`,
      };
    }
    return {
      ...base,
      unreachable: true,
      error:
        call.transportError ??
        (call.status !== undefined && call.status !== 0
          ? `tools/call answered ${call.status} with no readable JSON body`
          : "tools/call could not be reached"),
    };
  }

  const rpcError = asRecord(call.document.error);
  if (rpcError) {
    return {
      ...base,
      rpcError: {
        code: typeof rpcError.code === "number" ? rpcError.code : undefined,
        message: asString(rpcError.message)?.slice(0, 512),
      },
      ...(rpcError.code === -32602 ? { invalidArguments: true as const } : {}),
      error:
        asString(rpcError.message)?.slice(0, 512) ??
        "tools/call returned an error",
    };
  }

  const result = asRecord(call.document.result);
  if (!result) {
    return { ...base, error: "tools/call returned no result" };
  }
  const isError = result.isError === true;
  return {
    ...base,
    result: {
      isError,
      ...(asRecord(result._meta) ? { _meta: asRecord(result._meta) } : {}),
    },
    ...(isError && reportsInputValidation(result.content)
      ? { invalidArguments: true as const }
      : {}),
  };
}
