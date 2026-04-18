import { API_ENDPOINTS } from "@/components/evals/constants";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import { getSessionToken } from "@/lib/session-token";
import {
  buildHostedEvalServerBatchRequest,
  buildHostedServerBatchRequest,
  buildHostedServerRequest,
} from "@/lib/apis/web/context";
import { listHostedTools } from "@/lib/apis/web/tools-api";
import { authFetch } from "@/lib/session-token";
import { getGuestBearerToken } from "@/lib/guest-session";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";
import type { PromptTurn } from "@/shared/prompt-turns";

export const EVALS_API_ENDPOINTS = {
  local: {
    run: "/api/mcp/evals/run",
    generateTests: "/api/mcp/evals/generate-tests",
    generateNegativeTests: "/api/mcp/evals/generate-negative-tests",
    runTestCase: "/api/mcp/evals/run-test-case",
    runTestCaseInline: "/api/mcp/evals/run-test-case-inline",
    streamTestCase: "/api/mcp/evals/stream-test-case",
    streamTestCaseInline: "/api/mcp/evals/stream-test-case-inline",
    replayRun: "/api/mcp/evals/replay-run",
    traceRepairStart: "/api/mcp/evals/trace-repair/start",
    traceRepairStop: "/api/mcp/evals/trace-repair/stop",
  },
  hosted: {
    run: "/api/web/evals/run",
    generateTests: "/api/web/evals/generate-tests",
    generateNegativeTests: "/api/web/evals/generate-negative-tests",
    runTestCase: "/api/web/evals/run-test-case",
    runTestCaseInline: "/api/web/evals/run-test-case-inline",
    streamTestCase: "/api/web/evals/stream-test-case",
    streamTestCaseInline: "/api/web/evals/stream-test-case-inline",
    replayRun: "/api/web/evals/replay-run",
    traceRepairStart: "/api/web/evals/trace-repair/start",
    traceRepairStop: "/api/web/evals/trace-repair/stop",
  },
} as const;

type JsonRecord = Record<string, unknown>;

type EvalRequestWithServers = {
  workspaceId?: string | null;
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
  };
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
  ReturnType<typeof buildHostedServerBatchRequest> {
  const hostedBatch = buildHostedServerBatchRequest(request.serverIds);
  const {
    convexAuthToken: _convexAuthToken,
    serverIds: _serverIds,
    ...requestWithoutConvexAuthToken
  } = request;

  return {
    ...requestWithoutConvexAuthToken,
    ...hostedBatch,
    workspaceId: request.workspaceId ?? hostedBatch.workspaceId,
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
    hosted: () =>
      postEvalRequest(EVALS_API_ENDPOINTS.hosted.run, {
        ...mergeHostedServerBatch(request),
        storageServerIds: request.storageServerIds ?? request.serverIds,
      } as JsonRecord),
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

type GuestServerPayload = {
  serverUrl: string;
  serverHeaders?: Record<string, string>;
  serverName?: string;
  oauthAccessToken?: string;
  clientCapabilities?: Record<string, unknown>;
};

/**
 * Shape the guest server descriptor into the body fragment that
 * `withEphemeralConnection`'s guest path expects. Callers spread this into
 * their request body alongside `serverIds: ["__guest__"]`.
 */
function buildGuestEvalServerFragment(
  serverNameOrId: string,
): GuestServerPayload {
  const serverPayload = buildHostedServerRequest(
    serverNameOrId,
  ) as GuestServerPayload;
  if (!serverPayload.serverUrl) {
    throw new Error(
      `Guest eval request requires a direct serverUrl for "${serverNameOrId}". Is the server configured locally?`,
    );
  }
  return serverPayload;
}

async function requireGuestSessionToken(): Promise<string> {
  const guestToken = await getGuestBearerToken();
  if (!guestToken) {
    throw new Error("Could not obtain a guest session. Try refreshing the page.");
  }
  return guestToken;
}

/**
 * Guest-mode variant of `generateEvalTests`. In hosted mode, sends the direct
 * serverUrl body shape that `withEphemeralConnection`'s guest path recognizes.
 * In local mode (npx/electron), sends the normal body shape to the local
 * `/api/mcp/evals/generate-tests` and attaches a guest JWT as `convexAuthToken`
 * so the Convex LLM proxy accepts the request.
 */
export async function generateEvalTestsGuest({
  serverNameOrId,
}: {
  serverNameOrId: string;
}): Promise<GenerateEvalTestsResponse> {
  if (isHostedMode()) {
    const serverPayload = buildGuestEvalServerFragment(serverNameOrId);
    const body: JsonRecord = {
      serverIds: ["__guest__"],
      ...serverPayload,
    };
    return postEvalRequest(EVALS_API_ENDPOINTS.hosted.generateTests, body);
  }

  const guestToken = await requireGuestSessionToken();
  const body: JsonRecord = {
    serverIds: [serverNameOrId],
    convexAuthToken: guestToken,
  };
  return postEvalRequest(EVALS_API_ENDPOINTS.local.generateTests, body);
}

export type RunInlineEvalTestCaseGuestRequest = {
  serverNameOrId: string;
  model: string;
  provider: string;
  compareRunId?: string;
  modelApiKeys?: Record<string, string>;
  test: {
    title: string;
    query: string;
    runs?: number;
    expectedToolCalls?: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }>;
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    promptTurns?: PromptTurn[];
    advancedConfig?: Record<string, unknown>;
  };
};

/**
 * Guest-mode inline run. Hosted mode hits the hosted inline endpoint using the
 * direct serverUrl body. Local mode (npx/electron) hits the local inline route
 * which uses the persistent MCP client manager. Both paths run the test with
 * an ephemeral recorder and return the full iteration object for local storage.
 */
export async function runInlineEvalTestCaseGuest(
  request: RunInlineEvalTestCaseGuestRequest,
): Promise<{ success: boolean; iteration: any }> {
  if (isHostedMode()) {
    const serverPayload = buildGuestEvalServerFragment(request.serverNameOrId);
    const body: JsonRecord = {
      serverIds: ["__guest__"],
      ...serverPayload,
      model: request.model,
      provider: request.provider,
      ...(request.compareRunId ? { compareRunId: request.compareRunId } : {}),
      ...(request.modelApiKeys ? { modelApiKeys: request.modelApiKeys } : {}),
      test: request.test as unknown as JsonRecord,
    };
    return postEvalRequest(EVALS_API_ENDPOINTS.hosted.runTestCaseInline, body);
  }

  // Local mode: attach guest JWT so Convex-routed LLM calls (MCPJam models)
  // are authorized; direct provider calls via AI SDK ignore this token.
  const guestToken = await requireGuestSessionToken();
  const body: JsonRecord = {
    serverIds: [request.serverNameOrId],
    model: request.model,
    provider: request.provider,
    ...(request.compareRunId ? { compareRunId: request.compareRunId } : {}),
    ...(request.modelApiKeys ? { modelApiKeys: request.modelApiKeys } : {}),
    test: request.test as unknown as JsonRecord,
    ...(guestToken ? { convexAuthToken: guestToken } : {}),
  };
  return postEvalRequest(EVALS_API_ENDPOINTS.local.runTestCaseInline, body);
}

async function streamEvalRequest(
  endpoint: string,
  payload: JsonRecord,
  onEvent: (event: EvalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await authFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let errorMessage = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") errorMessage = body.error;
      else if (typeof body?.message === "string") errorMessage = body.message;
    } catch {
      // ignore parse errors
    }
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
    ? (mergeHostedServerBatch(request) as JsonRecord)
    : (request as JsonRecord);

  return streamEvalRequest(endpoint, payload, onEvent, signal);
}

export async function streamInlineEvalTestCaseGuest(
  request: RunInlineEvalTestCaseGuestRequest,
  onEvent: (event: EvalStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isHostedMode()) {
    const serverPayload = buildGuestEvalServerFragment(request.serverNameOrId);
    const payload: JsonRecord = {
      serverIds: ["__guest__"],
      ...serverPayload,
      model: request.model,
      provider: request.provider,
      ...(request.compareRunId ? { compareRunId: request.compareRunId } : {}),
      ...(request.modelApiKeys ? { modelApiKeys: request.modelApiKeys } : {}),
      test: request.test as unknown as JsonRecord,
    };
    return streamEvalRequest(
      EVALS_API_ENDPOINTS.hosted.streamTestCaseInline,
      payload,
      onEvent,
      signal,
    );
  }

  const guestToken = await requireGuestSessionToken();
  const payload: JsonRecord = {
    serverIds: [request.serverNameOrId],
    model: request.model,
    provider: request.provider,
    ...(request.compareRunId ? { compareRunId: request.compareRunId } : {}),
    ...(request.modelApiKeys ? { modelApiKeys: request.modelApiKeys } : {}),
    test: request.test as unknown as JsonRecord,
    ...(guestToken ? { convexAuthToken: guestToken } : {}),
  };
  return streamEvalRequest(
    EVALS_API_ENDPOINTS.local.streamTestCaseInline,
    payload,
    onEvent,
    signal,
  );
}
