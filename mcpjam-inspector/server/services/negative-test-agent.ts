import type { ServerToolSnapshot } from "../utils/export-helpers.js";
import type { ServerAttachmentInput } from "./eval-agent";
import { upstreamRefusalFromResponse } from "./upstream-refusal.js";

/**
 * Inspector-side adapter for backend negative eval test-case generation.
 * Wraps `/eval-generation/generate` with `mode: "negative"`. Prompt and
 * normalization live in the backend.
 */

export interface GeneratedNegativeTestCase {
  title: string;
  scenario: string;
  query: string;
  runs: number;
}

interface BackendGeneratedTestCase {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  scenario: string;
  expectedOutput: string;
  isNegativeTest: boolean;
}

export async function generateNegativeTestCases(
  toolSnapshot: ServerToolSnapshot,
  convexHttpUrl: string,
  convexAuthToken: string,
  serverAttachment?: ServerAttachmentInput,
  projectId?: string,
): Promise<GeneratedNegativeTestCase[]> {
  const response = await fetch(`${convexHttpUrl}/eval-generation/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${convexAuthToken}`,
    },
    body: JSON.stringify({
      mode: "negative",
      toolSnapshot,
      ...(projectId ? { projectId } : {}),
      ...(serverAttachment ? { serverAttachment } : {}),
    }),
  });

  if (!response.ok) {
    // Same refusal passthrough as the normal-mode sibling — see
    // `upstreamRefusalFromResponse`. Both modes hit one backend route, so a
    // 429 that only one of them forwarded would be a coin-flip for the caller.
    throw await upstreamRefusalFromResponse(
      response,
      "Failed to generate negative test cases",
    );
  }

  const data = (await response.json()) as {
    ok?: boolean;
    tests?: BackendGeneratedTestCase[];
    error?: string;
  };

  if (!data.ok || !Array.isArray(data.tests)) {
    throw new Error(
      `Invalid response from backend eval generation: ${data.error ?? "unknown error"}`,
    );
  }

  return data.tests.map((tc) => ({
    title: tc.title,
    scenario: tc.scenario,
    query: tc.query,
    runs: tc.runs,
  }));
}

/**
 * Converts generated negative test cases to the legacy eval-system shape.
 * Kept for `shared/evals.ts:generateNegativeEvalTestsWithManager`, which
 * still returns both the raw negative shape and an eval-shaped variant.
 */
export function convertToEvalTestCases(
  negativeTestCases: GeneratedNegativeTestCase[],
): Array<{
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: never[];
  isNegativeTest: true;
}> {
  return negativeTestCases.map((tc) => ({
    title: tc.title,
    query: tc.query,
    runs: tc.runs,
    expectedToolCalls: [] as never[],
    isNegativeTest: true as const,
  }));
}
