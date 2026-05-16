import { API_ENDPOINTS } from "@/components/evals/constants";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import { getSessionToken } from "@/lib/session-token";
import {
  buildHostedEvalServerBatchRequest,
  buildServerBatchRequest,
} from "@/lib/apis/web/context";
import { listHostedTools } from "@/lib/apis/web/tools-api";
import { authFetch } from "@/lib/session-token";
import { notifyMCPJamLimitError } from "@/lib/mcpjam-limit";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import type { PromptTurn } from "@/shared/prompt-turns";
import type { EvalMatchOptions } from "@/shared/eval-matching";

export const EVALS_API_ENDPOINTS = {
  local: {
    run: "/api/mcp/evals/run",
    generateTests: "/api/mcp/evals/generate-tests",
    generateNegativeTests: "/api/mcp/evals/generate-negative-tests",
    runTestCase: "/api/mcp/evals/run-test-case",
    streamTestCase: "/api/mcp/evals/stream-test-case",
    replayRun: "/api/mcp/evals/replay-run",
    traceRepairStart: "/api/mcp/evals/trace-repair/start",
    traceRepairStop: "/api/mcp/evals/trace-repair/stop",
  },
  hosted: {
    run: "/api/web/evals/run",
    generateTests: "/api/web/evals/generate-tests",
    generateNegativeTests: "/api/web/evals/generate-negative-tests",
    runTestCase: "/api/web/evals/run-test-case",
    streamTestCase: "/api/web/evals/stream-test-case",
    replayRun: "/api/web/evals/replay-run",
    traceRepairStart: "/api/web/evals/trace-repair/start",
    traceRepairStop: "/api/web/evals/trace-repair/stop",
  },
} as const;

type JsonRecord = Record<string, unknown>;
type EvalRequestWithServers = {
  projectId?: string | null;
  serverIds: string[];
};

type ToolListResponse = {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    serverId?: string;
  }>;
};

type RunEvalsRequest = EvalRequestWithServers & {
  suiteId?: string;
  suiteName?: string;
  suiteDescription?: string;
  tests: Array<Record<string, unknown>>;
  storageServerIds?: string[];
  modelApiKeys?: Record<string, string>;
  convexAuthToken?: string | null;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
  /**
   * True for suite reruns of already-persisted cases. Tells the server to
   * skip the per-case upsert path so suite-default-derived wire fields
   * (substituted models, merged advancedConfig) don't get baked into
   * per-case overrides.
   */
  suiteRerun?: boolean;
  /**
   * Transient per-run iteration count (1-10). Server overlays `runs` on
   * every test case in the run snapshot; persisted `EvalCase.runs`
   * default is not mutated.
   */
  iterationOverride?: number;
  /**
   * One-off match-option override applied to every iteration of this run
   * (layered on top of suite default + case override). Does not mutate
   * persisted suite/case records.
   */
  matchOptionsOverride?: EvalMatchOptions;
  /**
   * Scope this run to a single host attached to the suite. The backend
   * snapshots the host's current config and derives the run's server
   * environment from it. When the suite has multiple host attachments,
   * the UI makes one parallel request per host.
   */
  namedHostId?: string;
};

type RunTestCaseRequest = EvalRequestWithServers & {
  testCaseId: string;
  model: string;
  provider: string;
  compareRunId?: string;
  skipLastMessageRunUpdate?: boolean;
  modelApiKeys?: Record<string, string>;
  convexAuthToken?: string | null;
  testCaseOverrides?: {
    query?: string;
    expectedToolCalls?: Array<unknown>;
    isNegativeTest?: boolean;
    runs?: number;
    expectedOutput?: string;
    promptTurns?: Array<{
      id: string;
      prompt: string;
      expectedToolCalls: Array<{
        toolName: string;
        arguments: Record<string, unknown>;
      }>;
      expectedOutput?: string;
    }>;
    advancedConfig?: Record<string, unknown>;
    matchOptions?: EvalMatchOptions;
  };
  /** One-off run override; does not persist on the case. */
  matchOptionsOverride?: EvalMatchOptions;
};

type GenerateTestsRequest = EvalRequestWithServers & {
  convexAuthToken?: string | null;
};

export type GeneratedEvalTestCase = {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  isNegativeTest?: boolean;
  scenario?: string;
  expectedOutput?: string;
  promptTurns?: PromptTurn[];
};

export type GenerateEvalTestsResponse = {
  success: boolean;
  tests: GeneratedEvalTestCase[];
  evalTests?: GeneratedEvalTestCase[];
};

export function getEvalApiEndpoints() {
  return isHostedMode()
    ? EVALS_API_ENDPOINTS.hosted
    : EVALS_API_ENDPOINTS.local;
}

export function buildEvalServerBatchPayload(serverNames: string[]) {
  if (isHostedMode()) {
    return buildHostedEvalServerBatchRequest(serverNames);
  }

  return {
    serverIds: serverNames,
    serverNames,
  };
}

export function buildEvalConvexAuthPayload(convexAuthToken: string) {
  return isHostedMode() ? {} : { convexAuthToken };
}

function mergeHostedServerBatch<
  T extends EvalRequestWithServers & { convexAuthToken?: string | null },
>(
  request: T,
): Omit<T, "serverIds" | "convexAuthToken"> &
  ReturnType<typeof buildServerBatchRequest> {
  const hostedBatch = buildServerBatchRequest(request.serverIds);
  const {
    convexAuthToken: _convexAuthToken,
    serverIds: _serverIds,
    ...requestWithoutConvexAuthToken
  } = request;

  return {
    ...requestWithoutConvexAuthToken,
    ...hostedBatch,
  };
}

async function postEvalRequest<TResponse>(
  path: string,
  payload: JsonRecord,
): Promise<TResponse> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // ignored
  }

  if (!response.ok) {
    const errorBody = body as
      | {
          message?: unknown;
          error?: unknown;
          code?: unknown;
        }
      | null
      | undefined;
    const message =
      typeof errorBody?.message === "string"
        ? errorBody.message
        : typeof errorBody?.error === "string"
          ? errorBody.error
          : `Request failed (${response.status})`;
    const limitKind = (errorBody as { limitKind?: unknown } | null | undefined)
      ?.limitKind;
    notifyMCPJamLimitError({
      code: typeof errorBody?.code === "string" ? errorBody.code : undefined,
      details: body,
      message,
      limitKind:
        limitKind === "total" || limitKind === "concurrency"
          ? limitKind
          : undefined,
    });
    throw new Error(message);
  }

  return body as TResponse;
}

export async function listEvalTools(
  request: EvalRequestWithServers,
): Promise<ToolListResponse> {
  if (request.serverIds.length === 0) {
    return { tools: [] };
  }

  return runByMode({
    local: () =>
      postEvalRequest<ToolListResponse>(API_ENDPOINTS.LIST_TOOLS, {
        serverIds: request.serverIds,
      }),
    hosted: async () => {
      const toolsByServer = await Promise.all(
        request.serverIds.map(async (serverNameOrId) => {
          const response = await listHostedTools({ serverNameOrId });
          return (response.tools ?? []).map((tool: any) => ({
            ...tool,
            serverId: serverNameOrId,
          }));
        }),
      );

      return {
        tools: toolsByServer.flat(),
      };
    },
  });
}

export async function runEvals(request: RunEvalsRequest): Promise<any> {
  return runByMode({
    local: () =>
      postEvalRequest(EVALS_API_ENDPOINTS.local.run, request as JsonRecord),
    hosted: () => {
      return postEvalRequest(EVALS_API_ENDPOINTS.hosted.run, {
        ...mergeHostedServerBatch(request),
        storageServerIds: request.storageServerIds ?? request.serverIds,
      } as JsonRecord);
    },
  });
}

export async function runEvalTestCase(
  request: RunTestCaseRequest,
): Promise<any> {
  return runByMode({
    local: () =>
      postEvalRequest(
        EVALS_API_ENDPOINTS.local.runTestCase,
        request as JsonRecord,
      ),
    hosted: () =>
      postEvalRequest(
        EVALS_API_ENDPOINTS.hosted.runTestCase,
        mergeHostedServerBatch(request) as JsonRecord,
      ),
  });
}

export async function generateEvalTests(
  request: GenerateTestsRequest,
): Promise<GenerateEvalTestsResponse> {
  return runByMode({
    local: () =>
      postEvalRequest(
        EVALS_API_ENDPOINTS.local.generateTests,
        request as JsonRecord,
      ),
    hosted: () =>
      postEvalRequest(
        EVALS_API_ENDPOINTS.hosted.generateTests,
        mergeHostedServerBatch(request) as JsonRecord,
      ),
  });
}

export async function generateNegativeEvalTests(
  request: GenerateTestsRequest,
): Promise<GenerateEvalTestsResponse> {
  return runByMode({
    local: () =>
      postEvalRequest(
        EVALS_API_ENDPOINTS.local.generateNegativeTests,
        request as JsonRecord,
      ),
    hosted: () =>
      postEvalRequest(
        EVALS_API_ENDPOINTS.hosted.generateNegativeTests,
        mergeHostedServerBatch(request) as JsonRecord,
      ),
  });
}

export type StartTraceRepairParams =
  | {
      scope: "suite";
      suiteId: string;
      sourceRunId: string;
      modelApiKeys?: Record<string, string>;
    }
  | {
      scope: "case";
      suiteId: string;
      sourceRunId: string;
      sourceIterationId: string;
      testCaseId: string;
      modelApiKeys?: Record<string, string>;
    };

export async function startTraceRepair(
  params: StartTraceRepairParams,
): Promise<{ success: boolean; jobId: string; existing?: boolean }> {
  return runByMode({
    local: () =>
      postEvalRequest(EVALS_API_ENDPOINTS.local.traceRepairStart, {
        ...params,
        convexAuthToken: getSessionToken(),
      } as JsonRecord),
    hosted: () =>
      postEvalRequest(EVALS_API_ENDPOINTS.hosted.traceRepairStart, {
        ...params,
      } as JsonRecord),
  });
}

export async function stopTraceRepair(jobId: string): Promise<void> {
  await runByMode({
    local: () =>
      postEvalRequest(EVALS_API_ENDPOINTS.local.traceRepairStop, {
        jobId,
        convexAuthToken: getSessionToken(),
      } as JsonRecord),
    hosted: () =>
      postEvalRequest(EVALS_API_ENDPOINTS.hosted.traceRepairStop, {
        jobId,
      } as JsonRecord),
  });
}

export async function streamEvalTestCase(
  request: RunTestCaseRequest,
  onEvent: (event: EvalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const endpoint = isHostedMode()
    ? EVALS_API_ENDPOINTS.hosted.streamTestCase
    : EVALS_API_ENDPOINTS.local.streamTestCase;

  const payload = isHostedMode()
    ? mergeHostedServerBatch(request) as JsonRecord
    : (request as JsonRecord);

  const response = await authFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let errorMessage = `Request failed (${response.status})`;
    let errorBody: unknown = null;
    let errorText = "";
    try {
      errorText = await response.text();
      errorBody = errorText ? JSON.parse(errorText) : null;
      if (
        errorBody &&
        typeof errorBody === "object" &&
        typeof (errorBody as { error?: unknown }).error === "string"
      ) {
        errorMessage = (errorBody as { error: string }).error;
      } else if (
        errorBody &&
        typeof errorBody === "object" &&
        typeof (errorBody as { message?: unknown }).message === "string"
      ) {
        errorMessage = (errorBody as { message: string }).message;
      }
    } catch {
      if (errorText) {
        errorBody = errorText;
      }
    }
    const limitKindRaw =
      errorBody && typeof errorBody === "object"
        ? (errorBody as { limitKind?: unknown }).limitKind
        : undefined;
    notifyMCPJamLimitError({
      code:
        errorBody &&
        typeof errorBody === "object" &&
        typeof (errorBody as { code?: unknown }).code === "string"
          ? (errorBody as { code: string }).code
          : undefined,
      details: errorBody ?? errorText,
      message: errorMessage,
      limitKind:
        limitKindRaw === "total" || limitKindRaw === "concurrency"
          ? limitKindRaw
          : undefined,
    });
    throw new Error(errorMessage);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body for streaming");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const emitSseLine = (line: string) => {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("data: ")) {
      return;
    }
    const data = trimmedLine.slice(6).trim();
    if (!data || data === "[DONE]") {
      return;
    }
    try {
      const event = JSON.parse(data) as EvalStreamEvent;
      if (event.type === "error") {
        // Best-effort recovery of structured limitKind from JSON-shaped
        // details so the concurrency carve-out is honored on the SSE
        // error path. Untouched if details aren't JSON.
        let limitKind: "total" | "concurrency" | undefined;
        if (typeof event.details === "string") {
          try {
            const parsed = JSON.parse(event.details);
            if (parsed && typeof parsed === "object") {
              const value = (parsed as { limitKind?: unknown }).limitKind;
              if (value === "total" || value === "concurrency") {
                limitKind = value;
              }
            }
          } catch {
            // not JSON; ignore
          }
        }
        notifyMCPJamLimitError({
          details: event.details,
          message: event.message,
          limitKind,
        });
      }
      onEvent(event);
    } catch {
      // ignore malformed lines
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        emitSseLine(line);
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split("\n")) {
      emitSseLine(line);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // ignore
    }
  }
}
