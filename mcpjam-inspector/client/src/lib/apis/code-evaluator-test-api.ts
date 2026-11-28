/**
 * "Test on a past iteration" for a code evaluator (EFTW-90): run an unsaved
 * evaluator once against a stored iteration of one of the suite's finished
 * runs, in a fresh box, writing nothing.
 *
 *   POST /api/v1/projects/:projectId/eval-suites/:suiteId/code-evaluators/test
 *
 * A refusal comes back in the v1 envelope with the backend's reviewed
 * message (a run still going, a test of the same iteration seconds ago, the
 * feature off, no such iteration, a full pool), and that message is what the
 * panel shows. The answer is checked at this boundary: one that doesn't
 * parse is a failure, not a result.
 */
import { z } from "zod";
import { authFetch } from "@/lib/session-token";

export type CodeEvaluatorTestRequest = {
  projectId: string;
  suiteId: string;
  iterationId: string;
  evaluator: {
    fileName: string;
    script: string;
    threshold?: number;
    id?: string;
  };
  /** The suite draft's grading network. */
  network?: "none" | "web";
};

const resultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("scored"),
    score: z.number(),
    threshold: z.number(),
    passed: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);

const responseSchema = z.object({
  runId: z.string(),
  iterationId: z.string(),
  /** `transcript`: the iteration has no stored files, so the script saw only the transcript. */
  input: z.enum(["stored", "transcript"]),
  network: z.enum(["none", "web"]),
  result: resultSchema,
  logs: z.object({
    output: z.string(),
    exitCode: z.number().optional(),
    durationMs: z.number(),
  }),
});

export type CodeEvaluatorTestResult = z.infer<typeof responseSchema>;

/** A test that didn't produce a result; `message` is fit to show as is. */
export class CodeEvaluatorTestError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "CodeEvaluatorTestError";
    this.status = options.status;
    this.code = options.code;
  }
}

export const CODE_EVALUATOR_TEST_FAILED_COPY =
  "Couldn't test the evaluator on this iteration. Run the test again.";

/** The v1 envelope's code and message: `{ code, message }` or `{ error: { … } }`. */
function readEnvelope(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object") return {};
  const root = body as Record<string, unknown>;
  const nested =
    root.error && typeof root.error === "object"
      ? (root.error as Record<string, unknown>)
      : undefined;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value : undefined;
  return {
    code: text(root.code) ?? text(nested?.code),
    message: text(root.message) ?? text(nested?.message),
  };
}

export async function testCodeEvaluator(
  request: CodeEvaluatorTestRequest,
): Promise<CodeEvaluatorTestResult> {
  const path = `/api/v1/projects/${encodeURIComponent(request.projectId)}/eval-suites/${encodeURIComponent(request.suiteId)}/code-evaluators/test`;
  let response: Response;
  try {
    response = await authFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        iterationId: request.iterationId,
        evaluator: request.evaluator,
        ...(request.network ? { network: request.network } : {}),
      }),
    });
  } catch (error) {
    throw new CodeEvaluatorTestError(
      "Couldn't reach the server to run the test. Check your connection, then run it again.",
      { cause: error },
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch (error) {
    // A proxy's HTML page or a cut-off answer: there is no message to show.
    body = undefined;
    if (response.ok) {
      throw new CodeEvaluatorTestError(
        "Couldn't read the test result. Run the test again.",
        { status: response.status, cause: error },
      );
    }
  }

  if (!response.ok) {
    const envelope = readEnvelope(body);
    throw new CodeEvaluatorTestError(
      envelope.message ?? CODE_EVALUATOR_TEST_FAILED_COPY,
      { status: response.status, code: envelope.code },
    );
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new CodeEvaluatorTestError(
      "Couldn't read the test result. Run the test again.",
      { status: response.status, cause: parsed.error },
    );
  }
  return parsed.data;
}
