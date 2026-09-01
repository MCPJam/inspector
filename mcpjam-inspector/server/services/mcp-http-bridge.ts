import { MCPClientManager, describeError } from "@mcpjam/sdk";
import type { NormalizedError } from "@mcpjam/sdk";
import { z } from "zod";
import type { StreamFailureReporter } from "../utils/stream-failure-reporter.js";
import { resolveBridgeToolCallTarget } from "./mcp-tool-call-target.js";

// Unify JSON-RPC handling used by adapter-http and manager-http routes
// while preserving their minor response-shape differences.

export type BridgeMode = "adapter" | "manager";

export type JsonRpcBridgeOptions = {
  /**
   * Observation-only hook for a failed `tools/call`. Failures in the hook are
   * isolated so they can never change the JSON-RPC response.
   */
  onToolCallError?: (context: {
    error: unknown;
    serverId: string;
    toolCallId?: string;
    toolName?: string;
    toolInput?: unknown;
  }) => void | Promise<void>;
  /**
   * Typed-telemetry seam: every real bridge failure leaves this process as
   * an HTTP 200 carrying a JSON-RPC error envelope (or, in manager mode, a
   * success envelope with `isError: true`), so `http.request.failed` never
   * sees it. The reporter records it as `route.operation.failed`. Reporter
   * failures are isolated exactly like `onToolCallError` — telemetry can
   * never change the JSON-RPC response.
   */
  failureReporter?: StreamFailureReporter;
  /**
   * Firsthand tool-call EVIDENCE for harness eval runs.
   *
   * Deliberately NOT another `onToolCallError`. That hook is observation-only
   * and its failures are swallowed; this one is load-bearing and its failures
   * change what happens:
   *
   *   `beforeExecute` is AWAITED and its refusal STOPS THE CALL. The user's
   *   server is never contacted, and the harness gets a typed
   *   evidence-unavailable error — because a call that executed without a
   *   durable record of it having started is exactly the silent loss the whole
   *   protocol exists to prevent.
   *
   *   `afterExecute` is AWAITED but never changes the result. Settlement
   *   failure leaves a durable `started` row, which marks the turn incomplete;
   *   re-executing a side-effecting call to try again would be worse than
   *   losing the record of it.
   *
   * Inert for every non-harness adapter: no hook, no cost, and a fully-off run
   * is byte-identical to one from before evidence existed.
   */
  toolCallEvidence?: ToolCallEvidenceHook;
};

/**
 * The evidence seam around one proxied `tools/call`.
 *
 * It sits INSIDE the bridge rather than at the route because the two facts the
 * evidence row is keyed on — the resolved target server and the un-prefixed
 * tool name — only exist after `resolveBridgeToolCallTarget` has run. A hook
 * at the route would record the name the harness sent, which for a prefixed
 * call is not the tool that executed.
 */
export type ToolCallEvidenceHook = {
  /**
   * Called after target resolution and BEFORE the user's server. Returning
   * `{ ok: false }` aborts the call with `reason` as the model-visible error.
   */
  beforeExecute: (context: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Called with the outcome, before the result returns to the harness.
   * `outcome.kind` distinguishes a `CallToolResult` (including one with
   * `isError: true`, which is a domain answer the model reads) from a thrown
   * failure the bridge will turn into a JSON-RPC error envelope.
   */
  afterExecute: (context: {
    serverId: string;
    toolName: string;
    outcome:
      | { kind: "result"; result: unknown }
      | { kind: "error"; error: unknown };
  }) => Promise<void>;
};

/**
 * JSON-RPC application error for "the call did not run because its evidence
 * could not be recorded".
 *
 * -32001 rather than the -32000 the bridge uses for an upstream tool failure:
 * the two are opposite claims about the user's server. -32000 means it ran and
 * failed; this means it never ran at all, and a harness (or a human reading
 * the trace) must not have to guess which.
 */
export const EVIDENCE_UNAVAILABLE_CODE = -32001;

/**
 * The default refusal text, used when the hook rejects rather than returning a
 * reason of its own.
 *
 * Written for the two readers it actually has: a model deciding what to do
 * next, and a human reading the trace. Both need to know the tool did not run.
 */
const EVIDENCE_UNAVAILABLE_MESSAGE =
  "MCPJam could not record this tool call, so it was not executed. No action was taken on the server.";

/**
 * Run `beforeExecute` and reduce every outcome to a verdict. NEVER THROWS.
 *
 * A hook that rejects is treated exactly like one that refuses: the call does
 * not run. The alternative — letting the rejection propagate — would put an
 * evidence-layer bug on the same path as an upstream tool failure, where it
 * would be reported as the server having failed.
 */
async function beginToolCallEvidence(
  hook: ToolCallEvidenceHook,
  context: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const verdict = await hook.beforeExecute(context);
    if (verdict.ok) return { ok: true };
    return {
      ok: false,
      reason: verdict.reason || EVIDENCE_UNAVAILABLE_MESSAGE,
    };
  } catch {
    return { ok: false, reason: EVIDENCE_UNAVAILABLE_MESSAGE };
  }
}

/**
 * Run `afterExecute`. NEVER THROWS, and never changes the result.
 *
 * The call already happened. Its side effects are real whether or not the
 * record of them landed, so a settlement failure must not turn a successful
 * tool call into a failed one — the durable `started` row is what carries the
 * loss, by marking the turn incomplete.
 */
async function settleToolCallEvidence(
  hook: ToolCallEvidenceHook,
  context: {
    serverId: string;
    toolName: string;
    outcome:
      | { kind: "result"; result: unknown }
      | { kind: "error"; error: unknown };
  }
): Promise<void> {
  try {
    await hook.afterExecute(context);
  } catch {
    // Swallowed here; visible where it matters. The hook owns its own retry
    // budget and its own logging, and an exhausted settlement is already
    // recorded as an unsettled row.
  }
}

type JsonRpcBody = {
  id?: string | number | null;
  method?: string;
  params?: any;
};

type JsonRpcId = string | number | null;

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
};

export type JsonRpcValidation =
  | { ok: true; body: JsonRpcBody }
  | { ok: false; status: number; response: JsonRpcErrorResponse };

// Only a string / number / null id may be echoed back — a JSON-RPC error whose
// `id` is an object or array is itself malformed and harder for clients to
// correlate, so anything else normalizes to null.
function normalizeJsonRpcId(raw: unknown): JsonRpcId {
  return typeof raw === "string" || typeof raw === "number" ? raw : null;
}

/**
 * Parse + validate a single JSON-RPC 2.0 request from a request body reader,
 * shared by the harness proxy (`harness-mcp`) and the local MCP proxy
 * (`http-adapters`). On any problem it returns a ready-made JSON-RPC error
 * response (never a 202): a garbage body acknowledged as "Accepted" looks like
 * a delivered message to the client. On success it returns the parsed body.
 *
 * Rejections:
 *   - unparseable JSON → -32700 Parse error
 *   - not a JSON object, or a top-level array (JSON-RPC batch), or a present but
 *     non-`"2.0"` `jsonrpc`, or a missing/empty `method` → -32600 Invalid Request
 *
 * Batches (top-level arrays) are rejected deliberately: MCP (2025-06-18) removed
 * JSON-RPC batching and the bridge's `handleJsonRpc` processes a single request,
 * so an array is not a supported MCP message.
 *
 * An ABSENT `jsonrpc` is tolerated (not required): these bridge routes serve
 * spec-lenient tunneled MCP clients that historically POST without the version
 * field, and the 202-on-garbage bug is already closed by the non-empty `method`
 * requirement (a body with no method → -32600, never a fake 202). We still catch
 * a PRESENT but wrong version (e.g. `"1.0"`) as malformed. Callers that see
 * `ok: false` return `response` with `status`; `ok: true` bodies flow on to
 * `handleJsonRpc` (a valid notification still resolves there to a 202).
 */
export async function parseAndValidateJsonRpc(
  readJson: () => Promise<unknown>
): Promise<JsonRpcValidation> {
  let body: unknown;
  try {
    body = await readJson();
  } catch {
    return {
      ok: false,
      status: 400,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
    };
  }
  const obj =
    !!body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  // A non-scalar `id` or non-structured `params` must be rejected HERE, not just
  // normalized in the error path: an otherwise-valid request (valid `method`)
  // with an object/array `id` would otherwise flow to `handleJsonRpc`, which
  // echoes `id` verbatim into a SUCCESS response — emitting an invalid JSON-RPC
  // id. `params`, if present, must be structured (object/array) per JSON-RPC 2.0.
  if (
    !obj ||
    (obj.jsonrpc !== undefined && obj.jsonrpc !== "2.0") ||
    (obj.id !== undefined &&
      obj.id !== null &&
      typeof obj.id !== "string" &&
      typeof obj.id !== "number") ||
    (obj.params !== undefined &&
      obj.params !== null &&
      typeof obj.params !== "object") ||
    typeof obj.method !== "string" ||
    obj.method.length === 0
  ) {
    return {
      ok: false,
      status: 400,
      response: {
        jsonrpc: "2.0",
        id: obj ? normalizeJsonRpcId(obj.id) : null,
        error: { code: -32600, message: "Invalid Request" },
      },
    };
  }
  return { ok: true, body: body as JsonRpcBody };
}

export function buildInitializeResult(serverId: string, mode: BridgeMode) {
  if (mode === "adapter") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: { listChanged: true, subscribe: true },
        logging: {},
        roots: { listChanged: true },
      },
      serverInfo: { name: serverId, version: "stdio-adapter" },
    };
  }
  // manager mode (SSE transport facade)
  return {
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: true,
      prompts: true,
      resources: true,
      logging: false,
      elicitation: {},
      roots: { listChanged: true },
    },
    serverInfo: { name: serverId, version: "mcpjam-proxy" },
  };
}

function toJsonSchemaMaybe(schema: any): any {
  try {
    if (schema && typeof schema === "object") {
      // Detect Zod schema heuristically
      if (
        schema instanceof z.ZodType ||
        ("_def" in schema && "parse" in schema)
      ) {
        return z.toJSONSchema(schema as z.ZodType<any>);
      }
    }
  } catch {}
  return schema;
}

export async function handleJsonRpc(
  serverId: string,
  body: JsonRpcBody,
  clientManager: MCPClientManager,
  mode: BridgeMode,
  options: JsonRpcBridgeOptions = {}
): Promise<any | null> {
  const id = (body?.id ?? null) as any;
  const method = body?.method as string | undefined;
  const params = body?.params ?? {};

  // Treat missing method and notifications/* as notifications (no response envelope)
  if (!method || method.startsWith("notifications/")) {
    return null;
  }

  const respond = (payload: any) => ({ jsonrpc: "2.0", id, ...payload });

  /**
   * Whether a `-32020 HeaderMismatch` from this connection is MCPJam's bug.
   *
   * Per 2026-07-28 §Server Validation the server MUST answer `-32020` when the
   * mirrored `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` /
   * `Mcp-Param-*` headers disagree with the body; the spec's own table calls
   * the sender a "Non-conforming client". MCPJam builds those headers
   * mechanically from the body, so a rejection means OUR mirroring was wrong —
   * and upstream's evict-refetch-retry recovery has already failed by the time
   * one reaches here. This is not hypothetical: #3620 shipped exactly this bug
   * on the hosted MRTR resume leg, and its only wire signature was a `-32020`
   * filed as `ambiguous`.
   *
   * EXCEPT when the user asked for it. `toolParamHeaderMirroring: "omit"`
   * (surfaced as `mirrorToolParamHeaders: false`) deliberately simulates a
   * client that never mirrors, precisely so a user can check whether their
   * server answers `-32020` instead of silently serving the request. That is
   * the debugger working, and claiming it would page the team on a feature.
   */
  const isOwnRequestConstructionFault = (
    normalized: NormalizedError | undefined,
  ): boolean => {
    if (normalized?.slug !== "jsonrpc/header_mismatch") return false;
    // Optional call, not `manager.getServerConfig(...)`. This runs inside
    // `reportOperationFailure`'s swallowing try/catch, so a manager without
    // the accessor (a partial test double, an older embedder) would throw and
    // silently drop the ENTIRE report rather than just this refinement.
    const config = clientManager.getServerConfig?.(serverId);
    // Absent config reads as conforming, matching the knob's own default:
    // `mirrorToolParamHeaders` is opt-OUT, so only an explicit `false` is a
    // simulated non-conforming client.
    return config?.mirrorToolParamHeaders !== false;
  };

  // One call per failed operation. `hop: "user_server_hop"` at every site
  // except the one above: the bridge is a proxy into the user's own MCP
  // server, so the catalog's verdict stands and only MCPJam-positive slugs
  // escalate. Parse/Invalid-Request 400s deliberately do NOT report (already
  // visible as 4xx rows), nor does -32601 Method-not-implemented (a declared
  // client outcome).
  const reportOperationFailure = (
    error: unknown,
    rpcMethod: string,
    normalized?: NormalizedError,
    context?: Record<string, unknown>,
  ) => {
    try {
      // An UPSTREAM -32601 (the connected server rejecting an unknown
      // method, surfaced through the passthrough or outer catch) is the same
      // declared client outcome as our own -32601 short-circuit below —
      // excluded for the same reason.
      if ((error as { code?: unknown } | undefined)?.code === -32601) {
        return;
      }
      const ownRequestFault = isOwnRequestConstructionFault(normalized);
      options.failureReporter?.({
        message: `[mcp-bridge] ${rpcMethod} failed`,
        error,
        source: "mcp.bridge.rpc",
        hop: ownRequestFault
          ? "mcpjam_request_construction"
          : "user_server_hop",
        transport: "rpc_envelope",
        ...(normalized ? { normalized } : {}),
        errorCode: "-32000",
        rpcMethod,
        context: {
          serverId,
          mode,
          // The envelope code is always -32000; the UPSTREAM code is what
          // distinguishes a header mismatch, and a triager reading the row
          // should not have to infer it from the slug.
          ...(typeof (error as { code?: unknown } | undefined)?.code ===
          "number"
            ? { upstreamCode: (error as { code: number }).code }
            : {}),
          ...(context ?? {}),
        },
      });
    } catch {
      // Telemetry must never alter the JSON-RPC response.
    }
  };

  try {
    switch (method) {
      case "ping":
        return respond({ result: {} });
      case "initialize": {
        // Mirror the real upstream handshake (capabilities, serverInfo,
        // instructions) so remote clients negotiate against what the
        // connected server actually supports. The fabricated result is
        // only a fallback for servers that haven't connected yet.
        const info = clientManager.getInitializationInfo(serverId);
        if (info) {
          const result: any = {
            protocolVersion:
              info.protocolVersion ??
              (typeof params?.protocolVersion === "string"
                ? params.protocolVersion
                : "2025-06-18"),
            capabilities: info.serverCapabilities ?? {},
            serverInfo:
              info.serverVersion ??
              ({ name: serverId, version: "unknown" } as any),
          };
          if (info.instructions !== undefined) {
            result.instructions = info.instructions;
          }
          return respond({ result });
        }
        return respond({ result: buildInitializeResult(serverId, mode) });
      }
      case "tools/list": {
        const list = await clientManager.listTools(serverId);
        const tools = (list?.tools ?? []).map((tool: any) => {
          const mappedTool: any = {
            name: tool.name,
            description: tool.description,
            inputSchema: toJsonSchemaMaybe(tool.inputSchema),
            outputSchema: toJsonSchemaMaybe(
              tool.outputSchema ?? tool.resultSchema
            ),
          };
          // Preserve _meta field for OpenAI Apps SDK and other metadata
          if (tool._meta) {
            mappedTool._meta = tool._meta;
          }
          return mappedTool;
        });
        return respond({ result: { tools } });
      }
      case "tools/call": {
        let targetServerId = serverId;
        let observedToolName: string | undefined;
        const observedToolInput = params?.arguments ?? {};
        try {
          // Shared with the harness proxy's policy gate so a prefixed name
          // cannot resolve to one `(server, tool)` for the policy and another
          // for execution.
          const resolved = resolveBridgeToolCallTarget({
            serverId,
            toolName: params?.name as string | undefined,
            hasServer: (id) => clientManager.hasServer(id),
          });
          targetServerId = resolved.targetServerId;
          const toolName = resolved.toolName;
          if (!toolName) {
            throw new Error("Tool name is required");
          }
          observedToolName = toolName;

          const evidence = options.toolCallEvidence;
          const toolArguments = (params?.arguments ?? {}) as Record<
            string,
            unknown
          >;

          if (evidence) {
            // `beginToolCallEvidence` NEVER THROWS — that is the whole reason
            // it exists rather than an inline `await`. A hook rejection inside
            // this try block would land in the shared catch below and be
            // reported as -32000, telling the harness (and the trace) that a
            // call ran and failed when in fact none ran. It returns a verdict
            // instead, and the refusal answers with its own error code.
            const started = await beginToolCallEvidence(evidence, {
              serverId: targetServerId,
              toolName,
              arguments: toolArguments,
            });
            if (!started.ok) {
              return respond({
                error: {
                  code: EVIDENCE_UNAVAILABLE_CODE,
                  message: started.reason,
                },
              });
            }
          }

          let exec: unknown;
          try {
            exec = await clientManager.executeTool(
              targetServerId,
              toolName,
              toolArguments
            );
          } catch (executionError) {
            // Settle FIRST, then rethrow into the shared catch below, which
            // owns the response shape. The evidence of a failed call is worth
            // as much as the evidence of a successful one — a call the model
            // was told failed is the one a reader most wants the wire record
            // of.
            if (evidence) {
              await settleToolCallEvidence(evidence, {
                serverId: targetServerId,
                toolName,
                outcome: { kind: "error", error: executionError },
              });
            }
            throw executionError;
          }

          if (evidence) {
            // Awaited BEFORE the result goes back, so a turn that ends
            // normally cannot have settlement still in flight. Failure here
            // leaves a durable `started` row rather than changing the result:
            // re-executing a side-effecting call to record it better would be
            // worse than recording it incompletely.
            await settleToolCallEvidence(evidence, {
              serverId: targetServerId,
              toolName,
              outcome: { kind: "result", result: exec },
            });
          }

          if (mode === "manager") {
            return respond({ result: exec });
          }
          // adapter mode returns raw call-tool result for compatibility
          return respond({ result: exec });
        } catch (e: any) {
          try {
            await options.onToolCallError?.({
              error: e,
              serverId: targetServerId,
              ...(typeof id === "string" || typeof id === "number"
                ? { toolCallId: String(id) }
                : {}),
              ...(observedToolName ? { toolName: observedToolName } : {}),
              toolInput: observedToolInput,
            });
          } catch {
            // Observation-only: never turn a side-channel failure into an MCP
            // tool failure different from the upstream error.
          }
          const normalized = describeError(e);
          // In the SHARED catch, before the mode branch, deliberately:
          // manager mode answers with a SUCCESS envelope carrying
          // `isError: true` — a failure invisible to HTTP status AND to
          // JSON-RPC error accounting — and it must count exactly like the
          // adapter-mode -32000.
          reportOperationFailure(e, "tools/call", normalized, {
            ...(observedToolName ? { toolName: observedToolName } : {}),
            // A prefixed name ("otherServer:tool") reroutes the call; the
            // failure belongs to the server that actually executed it, not
            // the one in the URL.
            targetServerId,
          });
          if (mode === "manager") {
            const result = {
              content: [
                { type: "text", text: `Error: ${e?.message || String(e)}` },
              ],
              isError: true,
            };
            return respond({ result });
          }
          return respond({
            error: {
              code: -32000,
              message: e?.message || String(e),
              data: { normalized },
            },
          });
        }
      }
      case "resources/list": {
        const list = await clientManager.listResources(serverId);
        const resources = (list?.resources ?? []).map((r: any) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
        return respond({ result: { resources } });
      }
      case "resources/read": {
        try {
          const resource = await clientManager.readResource(serverId, {
            uri: params?.uri,
          });
          if (mode === "manager") {
            const firstContent = (resource as any)?.contents?.[0];
            const text =
              typeof firstContent?.text === "string"
                ? firstContent.text
                : typeof (resource as any) === "string"
                ? (resource as any)
                : JSON.stringify(resource, null, 2);
            const result = {
              contents: [
                {
                  uri: params?.uri,
                  mimeType:
                    firstContent?.mimeType ||
                    (typeof text === "string" ? "text/plain" : undefined),
                  text,
                },
              ],
            };
            return respond({ result });
          }
          // adapter mode returns raw content
          return respond({ result: resource });
        } catch (e: any) {
          const normalized = describeError(e);
          reportOperationFailure(e, "resources/read", normalized);
          return respond({
            error: {
              code: -32000,
              message: e?.message || String(e),
              data: { normalized },
            },
          });
        }
      }
      case "prompts/list": {
        const list = await clientManager.listPrompts(serverId);
        const prompts = (list?.prompts ?? []).map((p: any) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
        return respond({ result: { prompts } });
      }
      case "prompts/get": {
        try {
          const prompt = await clientManager.getPrompt(serverId, {
            name: params?.name,
            arguments: params?.arguments,
          });
          if (mode === "manager") {
            const result = {
              description:
                (prompt as any)?.description || `Prompt: ${params?.name}`,
              messages: (prompt as any)?.messages ?? [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: JSON.stringify(prompt, null, 2),
                  },
                },
              ],
            };
            return respond({ result });
          }
          // adapter mode returns raw content
          return respond({ result: prompt });
        } catch (e: any) {
          const normalized = describeError(e);
          reportOperationFailure(e, "prompts/get", normalized);
          return respond({
            error: {
              code: -32000,
              message: e?.message || String(e),
              data: { normalized },
            },
          });
        }
      }
      case "roots/list": {
        return respond({ result: { roots: [] } });
      }
      case "logging/setLevel": {
        return respond({ result: { success: true } });
      }
      default: {
        // Transparent passthrough: any method without bespoke response
        // shaping above is forwarded verbatim to the connected server
        // (resources/templates/list, resources/subscribe,
        // completion/complete, tasks/*, future spec methods, ...).
        const managed = clientManager.getManagedClient(serverId);
        if (managed) {
          try {
            const result = await managed.request({ method, params } as any);
            return respond({ result: result ?? {} });
          } catch (e: any) {
            const normalized = describeError(e);
            reportOperationFailure(e, method, normalized);
            return respond({
              error: {
                code: -32000,
                message: e?.message || String(e),
                data: { normalized },
              },
            });
          }
        }
        const notImpl = new Error(`Method not implemented: ${method}`);
        return respond({
          error: {
            code: -32601,
            message: notImpl.message,
            data: { normalized: describeError(notImpl) },
          },
        });
      }
    }
  } catch (e: any) {
    const normalized = describeError(e);
    reportOperationFailure(e, method, normalized);
    return respond({
      error: {
        code: -32000,
        message: e?.message || String(e),
        data: { normalized },
      },
    });
  }
}
