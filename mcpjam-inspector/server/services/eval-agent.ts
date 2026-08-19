import {
  deriveExpectedToolCalls,
  deriveQuery,
  normalizePromptTurns,
  normalizeSteps,
  type PromptTurn,
} from "@/shared/steps";
import type { TestStep } from "@/shared/steps";
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
  generationOptions?: GenerationOptions;
}

export interface ServerAttachmentInput {
  id?: string;
  name?: string;
  resolvedServerNames: string[];
}

/**
 * Per-bucket case counts for configurable generation. Field names mirror the
 * backend `CaseMix` (and the public SDK `caseMix`). Omitted buckets fall back to
 * the backend's mode default.
 */
export interface CaseMixInput {
  simple?: number;
  multiTool?: number;
  multiTurn?: number;
  complex?: number;
  negative?: number;
}

/**
 * Optional generation knobs forwarded verbatim to the backend
 * `/eval-generation/generate` body. Absent → today's default generation.
 */
export interface GenerationOptions {
  caseMix?: CaseMixInput;
  /** Condition cases on a generated persona slate for realistic phrasing. */
  varyUserStyles?: boolean;
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
  /**
   * The authored steps, when the backend produced the Wave-0 shape. The persist
   * loop prefers these over `query` / `expectedToolCalls` / `promptTurns`,
   * which stay populated as the legacy display projection.
   */
  steps?: TestStep[];
}

/**
 * LEGACY generated case — no `shapeVersion`.
 *
 * TEMPORARY (W0.3d removes it). This branch and `adaptBackendCase` exist only
 * for the window between this deploy and the backend's generation converging on
 * the Wave-0 shape (W0.3c). It lands FIRST on purpose: a consumer that already
 * accepts both shapes means the backend's change is not a breaking one, and
 * either side can be rolled back independently while both are deployed.
 */
interface BackendGeneratedTestCase {
  shapeVersion?: undefined;
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

/**
 * The Wave-0 generated case: `steps[]` replaces `query` + `expectedToolCalls` +
 * `promptTurns`, and `repetitions` replaces `runs`. `scenario`, `isNegativeTest`
 * and `expectedOutput` stay — they are case semantics, not legacy shape.
 */
interface BackendWave0TestCase {
  shapeVersion: "wave0";
  title: string;
  steps: unknown;
  repetitions?: number;
  scenario?: string;
  expectedOutput?: string;
  isNegativeTest?: boolean;
}

type BackendCase = BackendGeneratedTestCase | BackendWave0TestCase;

/**
 * Adapt whichever shape the backend sent.
 *
 * Discriminated on `shapeVersion` rather than on the presence of `steps`:
 * "which contract is this" must be a statement the producer makes, not a guess
 * this side infers from a field that a future shape could also carry.
 */
function adaptCase(tc: BackendCase): GeneratedTestCase {
  return tc.shapeVersion === "wave0"
    ? adaptWave0Case(tc)
    : adaptBackendCase(tc);
}

function adaptWave0Case(tc: BackendWave0TestCase): GeneratedTestCase {
  const steps = normalizeSteps(tc.steps);
  // `steps` IS the Wave-0 case. Null, an empty array, or entries that all fail
  // normalization leave nothing to run, and the legacy fields cannot stand in —
  // they are derived FROM the steps here. Persisting the result would author a
  // case that can never execute, so fail where the shape is still visible.
  if (steps.length === 0) {
    throw new Error(
      `Generated case ${JSON.stringify(tc.title)} declares shapeVersion ` +
        `"wave0" but has no usable steps.`
    );
  }
  return {
    title: tc.title,
    steps,
    // `query` and `expectedToolCalls` are DERIVED here, not authored. They are
    // the legacy display projection the case row still stores, and deriving
    // them from the steps keeps a Wave-0 case indistinguishable from a legacy
    // one everywhere those columns are read. `steps` remains the source of
    // truth for what actually runs.
    query: deriveQuery(steps),
    expectedToolCalls: deriveExpectedToolCalls(steps),
    runs: typeof tc.repetitions === "number" ? tc.repetitions : 1,
    scenario: tc.scenario ?? "",
    expectedOutput: tc.expectedOutput ?? "",
    isNegativeTest: tc.isNegativeTest === true,
  };
}

function adaptBackendCase(tc: BackendGeneratedTestCase): GeneratedTestCase {
  // Preserve `promptTurns: undefined` for single-turn cases. The backend
  // returns no `promptTurns` field for single-turn cases, and downstream
  // consumers (e.g. persistence shape, UI multi-turn affordances) treat
  // `undefined` and `[]` differently — an empty array suggests a multi-turn
  // case with no turns, which is a nonsensical state.
  const normalizedTurns =
    Array.isArray(tc.promptTurns) && tc.promptTurns.length > 0
      ? normalizePromptTurns(tc.promptTurns)
      : undefined;
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
    ...(normalizedTurns && normalizedTurns.length > 0
      ? { promptTurns: normalizedTurns }
      : {}),
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
  projectId?: string,
  generationOptions?: GenerationOptions
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
      ...(projectId ? { projectId } : {}),
      ...(serverAttachment ? { serverAttachment } : {}),
      ...(generationOptions?.caseMix
        ? { caseMix: generationOptions.caseMix }
        : {}),
      ...(generationOptions?.varyUserStyles ? { varyUserStyles: true } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to generate test cases: ${errorText}`);
  }

  const data = (await response.json()) as {
    ok?: boolean;
    tests?: BackendCase[];
    error?: string;
  };

  if (!data.ok || !Array.isArray(data.tests)) {
    throw new Error(
      `Invalid response from backend eval generation: ${
        data.error ?? "unknown error"
      }`
    );
  }

  return data.tests.map(adaptCase);
}
