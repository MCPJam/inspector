import { API_ENDPOINTS } from "@/components/evals/constants";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import { getSessionToken } from "@/lib/session-token";
import {
  buildHostedEvalServerBatchRequest,
  buildHostedServerBatchRequest,
} from "@/lib/apis/web/context";
import { listHostedTools } from "@/lib/apis/web/tools-api";
import { authFetch } from "@/lib/session-token";

export const EVALS_API_ENDPOINTS = {
  local: {
    run: "/api/mcp/evals/run",
    generateTests: "/api/mcp/evals/generate-tests",
    generateNegativeTests: "/api/mcp/evals/generate-negative-tests",
    runTestCase: "/api/mcp/evals/run-test-case",
    replayRun: "/api/mcp/evals/replay-run",
    traceRepairStart: "/api/mcp/evals/trace-repair/start",
    traceRepairStop: "/api/mcp/evals/trace-repair/stop",
  },
  hosted: {
    run: "/api/web/evals/run",
    generateTests: "/api/web/evals/generate-tests",
    generateNegativeTests: "/api/web/evals/generate-negative-tests",
    runTestCase: "/api/web/evals/run-test-case",
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
): Promise<any> {
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
): Promise<any> {
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
