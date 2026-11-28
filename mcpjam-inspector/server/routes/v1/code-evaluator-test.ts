/**
 * "Test on a past iteration" for a code evaluator (EFTW-90, plan step I5):
 *
 *   POST /projects/:projectId/eval-suites/:suiteId/code-evaluators/test
 *   { iterationId, evaluator: { fileName, script, threshold?, id? }, network? }
 *
 * The backend decides whether the caller may: the `eval-code-evaluators` flag
 * (spec amendment v1.2, D22), a member who can configure the suite, an
 * iteration from one of its finished runs, and a few seconds since the same
 * person tested the same iteration. Its refusals keep their reviewed wording.
 * The test itself is `evaluator-test.ts`.
 */
import { Hono, type Context } from "hono";
import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
import { codeEvaluatorTestRequestSchema } from "@mcpjam/sdk/contract";
import {
  testCodeEvaluator,
  type EvaluatorTestRefusal,
} from "../../services/evals/sandbox-phases/evaluator-test.js";
import { readFrozenCodeGrading } from "../../services/evals/sandbox-phases/frozen-config.js";
import {
  gradingInputSourceFromStored,
  type GradingInputSource,
} from "../../services/evals/sandbox-phases/grading-input.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, parseWithSchema, WebRouteError } from "../web/errors.js";
import { createConvexClient } from "./convex-client.js";
import { retryAfterFromMs } from "./convex-errors.js";
import {
  requireConvexIdParam,
  requireConvexIdShape,
} from "./convex-id-param.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import type { V1ErrorCode } from "./contract.js";
import { v1Error, v1Resource } from "./envelope.js";

const SCOPE = "v1.code-evaluator-test";
const SUITE_NOT_FOUND = "Eval suite not found";
/** Room for a 64 KiB script after JSON escapes grow it, and nothing else. */
const MAX_BODY_BYTES = 512 * 1024;

const getTestSuite = makeFunctionReference<
  "query",
  { suiteId: string },
  unknown
>("testSuites:getTestSuite");
const getTestSuiteRun = makeFunctionReference<
  "query",
  { runId: string },
  unknown
>("testSuites:getTestSuiteRun");
const getTestIteration = makeFunctionReference<
  "query",
  { iterationId: string },
  unknown
>("testSuites:getTestIteration");
const getTestIterationBlob = makeFunctionReference<
  "action",
  { iterationId: string },
  unknown
>("testSuites:getTestIterationBlob");

/** Make a suite from another of the caller's projects read as not found. */
async function requireSuiteInProject(
  convex: ConvexHttpClient,
  projectId: string,
  suiteId: string,
): Promise<void> {
  let suite: unknown;
  try {
    suite = await convex.query(getTestSuite, { suiteId });
  } catch (error) {
    throw translateConvexReadError(error, {
      scope: SCOPE,
      notFoundMessage: SUITE_NOT_FOUND,
      // The scoping read: a masked refusal here is "not yours", not an outage.
      redactedIsRefusal: true,
    });
  }
  const owner =
    suite && typeof suite === "object"
      ? (suite as { projectId?: unknown }).projectId
      : undefined;
  if (String(owner ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, SUITE_NOT_FOUND);
  }
}

/** The stored iteration and its trace, read as the member. */
async function readTranscript(
  convex: ConvexHttpClient,
  iterationId: string,
): Promise<GradingInputSource> {
  try {
    const [iteration, trace] = await Promise.all([
      convex.query(getTestIteration, { iterationId }),
      convex.action(getTestIterationBlob, { iterationId }),
    ]);
    return gradingInputSourceFromStored(iteration, trace);
  } catch (error) {
    throw translateConvexReadError(error, {
      scope: SCOPE,
      notFoundMessage: "Eval iteration not found",
    });
  }
}

/** The files the iteration's run froze for grading. */
async function readDeclaredFiles(
  convex: ConvexHttpClient,
  runId: string,
): Promise<readonly string[]> {
  try {
    const run = await convex.query(getTestSuiteRun, { runId });
    const snapshot =
      run && typeof run === "object"
        ? (run as { configSnapshot?: unknown }).configSnapshot
        : undefined;
    return readFrozenCodeGrading(snapshot).grading.files ?? [];
  } catch (error) {
    throw translateConvexReadError(error, {
      scope: SCOPE,
      notFoundMessage: "Eval run not found",
    });
  }
}

/** The backend's refusal statuses, onto the public codes. */
const CODE_BY_STATUS: Readonly<Record<number, V1ErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
  // The public codes have no 503: a full pool is a wait, so it reads as a
  // rate limit with the backend's own Retry-After.
  503: "RATE_LIMITED",
};

function refusalResponse(c: Context, refusal: EvaluatorTestRefusal) {
  const code = CODE_BY_STATUS[refusal.status];
  if (!code) {
    // Our own backend unreachable or failing: an incident, reported as one.
    throw new Error(
      `Couldn't start the code evaluator test box (status ${refusal.status}).`,
    );
  }
  const retryAfter = retryAfterFromMs(refusal.retryAfterMs);
  return v1Error(
    c,
    code,
    refusal.error,
    refusal.code ? { code: refusal.code } : undefined,
    retryAfter ? { "Retry-After": retryAfter } : undefined,
  );
}

const router = new Hono();

router.post(
  "/projects/:projectId/eval-suites/:suiteId/code-evaluators/test",
  async (c) => {
    const suiteId = requireConvexIdParam(c, "suiteId", {
      scope: SCOPE,
      notFoundMessage: SUITE_NOT_FOUND,
    });
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "Couldn't read the test because it is over 512 KB. A script can be at most 64 KB.",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "Couldn't read the test. Send it as a JSON object.",
      );
    }
    const request = parseWithSchema(codeEvaluatorTestRequestSchema, body);
    requireConvexIdShape(request.iterationId, "iterationId", {
      scope: SCOPE,
      notFoundMessage: "Eval iteration not found",
    });
    const bearer = await getConvexBearerForRequest(c);
    const convex = createConvexClient(bearer);
    await requireSuiteInProject(convex, c.req.param("projectId"), suiteId);
    const outcome = await testCodeEvaluator({
      bearer,
      suiteId,
      request,
      sources: {
        readTranscript: (iterationId) => readTranscript(convex, iterationId),
        readDeclaredFiles: (runId) => readDeclaredFiles(convex, runId),
      },
      signal: c.req.raw.signal,
    });
    return outcome.ok
      ? v1Resource(c, outcome.result)
      : refusalResponse(c, outcome.refusal);
  },
);

export default router;
