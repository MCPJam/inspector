import { normalizePromptTurns, type PromptTurn } from "@/shared/prompt-turns";
import type { ServerToolSnapshot } from "../utils/export-helpers.js";

/**
 * Inspector-side adapter for backend eval test-case generation.
 *
 * The system prompt + LLM call live in `mcpjam-backend/convex/evalGeneration/`.
 * This file is a thin fetch wrapper that posts the captured `ServerToolSnapshot`
 * plus optional `serverAttachment` metadata to the backend and trusts the
 * already-normalized response. Keep this file dependency-light — anything
 * authoring-related belongs server-side so it stays off shipped inspector
 * source.
 */

export interface GenerateTestsRequest {
  serverIds: string[];
  toolSnapshot: ServerToolSnapshot;
  serverAttachment?: ServerAttachmentInput;
}

export interface ServerAttachmentInput {
  id?: string;
  name?: string;
  resolvedServerNames: string[];
}

export interface GeneratedTestCase {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  scenario: string;
  expectedOutput: string;
  isNegativeTest?: boolean;
  promptTurns?: PromptTurn[];
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
  promptTurns?: Array<{
    prompt: string;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }>;
    expectedOutput?: string;
  }>;
}

function adaptBackendCase(tc: BackendGeneratedTestCase): GeneratedTestCase {
  return {
    title: tc.title,
    query: tc.query,
    runs: tc.runs,
    expectedToolCalls: tc.expectedToolCalls.map((call) => ({
      toolName: call.toolName,
      arguments: call.arguments as Record<string, any>,
    })),
    scenario: tc.scenario,
    expectedOutput: tc.expectedOutput,
    isNegativeTest: tc.isNegativeTest,
    promptTurns: normalizePromptTurns(tc.promptTurns),
  };
}

/**
 * Generates test cases via the backend eval-generation endpoint. The endpoint
 * owns both the system prompt and the structured normalization, so this
 * adapter only does the wire-protocol mapping.
 */
export async function generateTestCases(
  toolSnapshot: ServerToolSnapshot,
  convexHttpUrl: string,
  convexAuthToken: string,
  serverAttachment?: ServerAttachmentInput,
): Promise<GeneratedTestCase[]> {
  const response = await fetch(`${convexHttpUrl}/eval-generation/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${convexAuthToken}`,
    },
    body: JSON.stringify({
      mode: "normal",
      toolSnapshot,
      ...(serverAttachment ? { serverAttachment } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to generate test cases: ${errorText}`);
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

  return data.tests.map(adaptBackendCase);
}
