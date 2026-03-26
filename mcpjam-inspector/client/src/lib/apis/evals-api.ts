import { isHostedMode } from "@/lib/apis/mode-client";
import { buildHostedEvalServerBatchRequest } from "@/lib/apis/web/context";

export const EVALS_API_ENDPOINTS = {
  local: {
    run: "/api/mcp/evals/run",
    generateTests: "/api/mcp/evals/generate-tests",
    generateNegativeTests: "/api/mcp/evals/generate-negative-tests",
    runTestCase: "/api/mcp/evals/run-test-case",
    replayRun: "/api/mcp/evals/replay-run",
  },
  hosted: {
    run: "/api/web/evals/run",
    generateTests: "/api/web/evals/generate-tests",
    generateNegativeTests: "/api/mcp/evals/generate-negative-tests",
    runTestCase: "/api/web/evals/run-test-case",
    replayRun: "/api/web/evals/replay-run",
  },
} as const;

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
