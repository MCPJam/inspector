import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import { evalToolCaptureResolvers } from "./mcp-client-manager/eval-tool-capture.js";
import {
  assertEvalCaptureWithinLimit,
  DEFAULT_MAX_CAPTURED_BYTES,
} from "./eval-capture-limit.js";
import type {
  EvalResultInput,
  EvalTraceSpanInput,
} from "./eval-reporting-types.js";

export interface EvalRecorderOptions {
  mcpClientManager: MCPClientManager;
  /** Maximum retained JSON evidence per case; defaults to 16 MiB. */
  maxCapturedBytes?: number;
}
export interface EvalRecorderCaseOptions {
  caseTitle: string;
  caseId?: string;
}
export interface EvalRecorder {
  runCase<T>(
    options: EvalRecorderCaseOptions,
    callback: () => T | Promise<T>
  ): Promise<T>;
  /** Detached completed results. Throws while any case is still running. */
  getResults(): EvalResultInput[];
}
type RecordedCall = {
  id: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  startMs: number;
  endMs?: number;
  response?: unknown;
  error?: { message: string; code?: string | number };
  isError?: boolean;
};
type CaptureScope = {
  manager: MCPClientManager;
  started: number;
  closed: boolean;
  calls: RecordedCall[];
  maxBytes: number;
  bytes: number;
  captureError?: string;
};
const scopes = new AsyncLocalStorage<CaptureScope>();
function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}
function unavailable(scope: CaptureScope, error: unknown): void {
  scope.captureError = errorMessage(error);
  scope.calls = [];
}
function snapshot<T>(scope: CaptureScope, value: T): T {
  assertEvalCaptureWithinLimit(value, scope.maxBytes - scope.bytes);
  const json = JSON.stringify(value);
  scope.bytes += Buffer.byteLength(json, "utf8");
  return JSON.parse(json) as T;
}
function beginCall(serverId: string, toolName: string, args: unknown) {
  const scope = scopes.getStore();
  if (!scope || scope.closed || scope.captureError) return undefined;
  let call: RecordedCall;
  try {
    call = snapshot(scope, {
      id: randomUUID(),
      serverId,
      toolName,
      arguments: args,
      startMs: performance.now() - scope.started,
    }) as RecordedCall;
    scope.calls.push(call);
  } catch (error) {
    unavailable(scope, error);
    return undefined;
  }
  const finish = (response: unknown, error?: unknown, failed = false) => {
    if (scope.closed || scope.captureError) return;
    try {
      call.endMs = performance.now() - scope.started;
      if (failed) {
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        call.error = snapshot(scope, {
          message: errorMessage(error),
          ...(typeof code === "string" || typeof code === "number"
            ? { code }
            : {}),
        });
      } else {
        call.response = snapshot(scope, response);
        call.isError = Boolean(
          response &&
            typeof response === "object" &&
            "isError" in response &&
            response.isError === true
        );
      }
    } catch (captureError) {
      unavailable(scope, captureError);
    }
  };
  return {
    complete: (result: unknown) => finish(result),
    fail: (error: unknown) => finish(undefined, error, true),
  };
}

/**
 * Records tools called through the supplied manager inside each callback.
 * No framework hooks are installed. Await every tool call and place assertions
 * inside the callback. Inputs and full MCP responses are uploaded when these
 * results are passed to reportEvalResults; do not include secrets in payloads.
 */
export function createEvalRecorder(options: EvalRecorderOptions): EvalRecorder {
  const maxBytes = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new TypeError("maxCapturedBytes must be a positive safe integer");
  const manager = options.mcpClientManager;
  evalToolCaptureResolvers.set(manager, (serverId, toolName, args) =>
    scopes.getStore()?.manager === manager
      ? beginCall(serverId, toolName, args)
      : undefined
  );
  let active = 0;
  const results: EvalResultInput[] = [];
  return {
    async runCase<T>(
      config: EvalRecorderCaseOptions,
      callback: () => T | Promise<T>
    ): Promise<T> {
      if (scopes.getStore() && !scopes.getStore()!.closed)
        throw new Error("Nested runCase calls are not supported");
      if (
        !config.caseTitle?.trim() ||
        (config.caseId !== undefined && !config.caseId.trim())
      )
        throw new TypeError(
          "caseTitle and any supplied caseId must be nonempty"
        );
      const identity = {
        caseTitle: config.caseTitle,
        ...(config.caseId !== undefined ? { caseId: config.caseId } : {}),
      };
      const externalIterationId = randomUUID();
      const scope: CaptureScope = {
        manager,
        started: performance.now(),
        closed: false,
        calls: [],
        maxBytes,
        bytes: 0,
      };
      active++;
      let passed = false;
      let failure: unknown;
      try {
        const value = await scopes.run(scope, callback);
        passed = true;
        return value;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        scope.closed = true;
        active--;
        const durationMs = performance.now() - scope.started;
        const incomplete = scope.calls.some((call) => call.endMs === undefined);
        const messages: Array<{ role: string; content: unknown }> = [];
        const spans: EvalTraceSpanInput[] = [];
        for (const call of scope.calls) {
          const messageStartIndex = messages.length;
          messages.push({
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: call.id,
                toolName: call.toolName,
                input: call.arguments,
              },
            ],
          });
          if (call.endMs !== undefined)
            messages.push({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: call.id,
                  toolName: call.toolName,
                  output: {
                    type: call.error ? "error-json" : "json",
                    value: call.error ?? call.response,
                  },
                },
              ],
            });
          spans.push({
            id: call.id,
            toolCallId: call.id,
            name: call.toolName,
            toolName: call.toolName,
            serverId: call.serverId,
            category: "tool",
            startMs: call.startMs,
            endMs: call.endMs ?? durationMs,
            status:
              call.endMs === undefined
                ? undefined
                : call.error || call.isError
                  ? "error"
                  : "ok",
            evidenceStatus:
              call.endMs === undefined ? "incomplete" : "complete",
            messageStartIndex,
            messageEndIndex: messages.length - 1,
          });
        }
        const result: EvalResultInput = {
          ...identity,
          externalIterationId,
          passed,
          status: "completed",
          durationMs,
          ...(!passed ? { error: errorMessage(failure) } : {}),
          metadata: {
            sdkRecorderVersion: 1,
            captureCompleteness: scope.captureError
              ? "unavailable"
              : incomplete
                ? "incomplete"
                : "complete",
            ...(scope.captureError ? { captureError: scope.captureError } : {}),
          },
          ...(!scope.captureError
            ? {
                actualToolCalls: scope.calls.map((call) => ({
                  toolName: call.toolName,
                  arguments: call.arguments,
                })),
                trace: { messages, spans, raw: { sdkRecorderVersion: 1 } },
              }
            : {}),
        };
        // Bound the final wire evidence too (messages and actualToolCalls duplicate
        // input references). Capture failures never replace the callback outcome.
        try {
          assertEvalCaptureWithinLimit(
            { trace: result.trace, actualToolCalls: result.actualToolCalls },
            maxBytes
          );
        } catch (error) {
          delete result.trace;
          delete result.actualToolCalls;
          result.metadata = {
            sdkRecorderVersion: 1,
            captureCompleteness: "unavailable",
            captureError: errorMessage(error),
          };
        }
        results.push(result);
      }
    },
    getResults() {
      if (active)
        throw new Error(
          "Cannot getResults while cases are still running; await every runCase first"
        );
      return structuredClone(results);
    },
  };
}
