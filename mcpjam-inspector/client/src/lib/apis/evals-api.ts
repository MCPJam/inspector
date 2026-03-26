import { API_ENDPOINTS } from "@/components/evals/constants";
import { runByMode } from "@/lib/apis/mode-client";
import { buildHostedServerBatchRequest } from "@/lib/apis/web/context";
import { listHostedTools } from "@/lib/apis/web/tools-api";
import { authFetch } from "@/lib/session-token";

const HOSTED_EVALS_API_ENDPOINTS = {
  run: "/api/web/evals/run",
  runTestCase: "/api/web/evals/run-test-case",
  generateTests: "/api/web/evals/generate-tests",
  generateNegativeTests: "/api/web/evals/generate-negative-tests",
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
  modelApiKeys?: Record<string, string>;
  convexAuthToken?: string | null;
  testCaseOverrides?: {
    query?: string;
    expectedToolCalls?: Array<unknown>;
    isNegativeTest?: boolean;
    runs?: number;
  };
};

type GenerateTestsRequest = EvalRequestWithServers & {
  convexAuthToken?: string | null;
};

function mergeHostedServerBatch<T extends EvalRequestWithServers>(
  request: T,
): Omit<T, "serverIds"> & ReturnType<typeof buildHostedServerBatchRequest> {
  const hostedBatch = buildHostedServerBatchRequest(request.serverIds);

  return {
    ...request,
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
      | { message?: unknown; error?: unknown }
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
      postEvalRequest(API_ENDPOINTS.EVALS_RUN, request as JsonRecord),
    hosted: () =>
      postEvalRequest(
        HOSTED_EVALS_API_ENDPOINTS.run,
        {
          ...mergeHostedServerBatch(request),
          storageServerIds: request.storageServerIds ?? request.serverIds,
        } as JsonRecord,
      ),
  });
}

export async function runEvalTestCase(
  request: RunTestCaseRequest,
): Promise<any> {
  return runByMode({
    local: () =>
      postEvalRequest(
        API_ENDPOINTS.EVALS_RUN_TEST_CASE,
        request as JsonRecord,
      ),
    hosted: () =>
      postEvalRequest(
        HOSTED_EVALS_API_ENDPOINTS.runTestCase,
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
        API_ENDPOINTS.EVALS_GENERATE_TESTS,
        request as JsonRecord,
      ),
    hosted: () =>
      postEvalRequest(
        HOSTED_EVALS_API_ENDPOINTS.generateTests,
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
        API_ENDPOINTS.EVALS_GENERATE_NEGATIVE_TESTS,
        request as JsonRecord,
      ),
    hosted: () =>
      postEvalRequest(
        HOSTED_EVALS_API_ENDPOINTS.generateNegativeTests,
        mergeHostedServerBatch(request) as JsonRecord,
      ),
  });
}
