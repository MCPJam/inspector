/**
 * Public `/api/v1` evals beside one directory submission: the eval suite that
 * holds its test cases and the run that last ran them, each case's result in
 * that run, an import of the cases a ChatGPT plugin package declares, and the
 * cases in the shape the directory's form takes.
 *
 * Test cases need a conversation, so they run as evals, never as a readiness
 * run's direct calls. MCPJam's eval runs and judges grade them; a submission
 * only links to the suite and the run, and every result keeps the client that
 * ran it. The backend checks that both are in the submission's project.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { OPENAI_SUBMISSION_TEST_CASES } from "@mcpjam/sdk";
import type {
  PlatformDirectoryPortalTestCase as PortalCase,
  PlatformDirectorySubmissionEvalExport as EvalExport,
  PlatformDirectorySubmissionEvalImport as EvalImport,
  PlatformDirectorySubmissionEvalLink as EvalLink,
  PlatformDirectorySubmissionEvals as Evals,
} from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { requireConvexIdShape } from "./convex-id-param.js";
import { convexErrorData, translateConvexWriteError } from "./convex-errors.js";
import { v1Resource } from "./envelope.js";
import { flowOf, readSubmission, scopeOf } from "./directory-submissions.js";
import { readRefusal } from "./directory-submission-views.js";

const evals = new Hono();

const EVALS = "/projects/:projectId/directory-submissions/:submissionId/evals";
const SCOPE = "v1.directory-submissions";

const fn = {
  read: makeFunctionReference<"query">("directorySubmissionEvals:getDirectorySubmissionEvals"),
  link: makeFunctionReference<"mutation">("directorySubmissionEvals:setDirectorySubmissionEvals"),
  import: makeFunctionReference<"mutation">("directorySubmissionEvals:importDirectoryPluginTestCases"),
  cases: makeFunctionReference<"query">("testSuites:listTestCases"),
};

/**
 * The backend's refusals a caller acts on, each with its own sentence, which
 * names what to link, choose or reload. The rest translate like every other
 * write's: a stale revision is a 409 with `currentRevision` and `conflictingKeys`.
 */
const REFUSALS: ReadonlyMap<string, 404 | 409> = new Map([
  // The suite, the run or the plugin version, as the sentence says.
  ["NOT_FOUND", 404],
  ["no_eval_suite", 409],
  ["no_plugin_version", 409],
  ["plugin_version_not_applicable", 409],
  ["plugin_version_not_ready", 409],
  ["submission_mismatch", 409],
  // Here rather than the shared branch, whose hint offers a suite-file write.
  ["CI_OWNED_SUITE_READ_ONLY", 409],
]);

function writeRefusal(error: unknown, resource: string): WebRouteError {
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : "";
  const status = REFUSALS.get(code);
  if (!status || typeof data?.message !== "string" || !data.message.trim()) {
    return translateConvexWriteError(error, { resource });
  }
  const kind = status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT;
  return new WebRouteError(status, kind, data.message, { code });
}

const idOf = (value: string, param: string, notFoundMessage: string) =>
  requireConvexIdShape(value, param, { scope: SCOPE, notFoundMessage });

/** The submission the path names, read under the caller's bearer. */
async function opened(c: Context) {
  const { projectId, submissionId } = scopeOf(c);
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  return { convex, row: await readSubmission(convex, projectId, submissionId) };
}

async function readEvals(convex: ConvexHttpClient, submissionId: string): Promise<Evals> {
  let found: Evals | null;
  try {
    found = await convex.query(fn.read, { submissionId });
  } catch (error) {
    throw readRefusal(error, "Directory submission");
  }
  // Deleted since the submission was read.
  if (!found) throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Directory submission not found");
  return found;
}

evals.get(EVALS, async (c) => {
  const { convex, row } = await opened(c);
  return v1Resource(c, await readEvals(convex, row.id));
});

const nullableId = z.string().trim().min(1).max(100).nullable().optional();

const linkSchema = z.strictObject({
  /** The revision the caller read. A stale one conflicts only when the link changed since. */
  expectedRevision: z.number().int().min(1),
  /** A suite in the submission's project; `null` unlinks it and its run. */
  suiteId: nullableId,
  /** A run of the linked suite; `null` clears it. */
  runId: nullableId,
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

evals.patch(EVALS, async (c) => {
  const { expectedRevision, suiteId, runId, idempotencyKey } = parseWithSchema(
    linkSchema,
    await readJsonObjectBody(c),
  );
  const change = {
    expectedRevision,
    // `null` unlinks; left out, the link stays as it is.
    ...(suiteId !== undefined ? { suiteId: suiteId && idOf(suiteId, "suiteId", "Eval suite not found") } : {}),
    ...(runId !== undefined ? { runId: runId && idOf(runId, "runId", "Eval run not found") } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  const { convex, row } = await opened(c);
  let linked: EvalLink;
  try {
    linked = await convex.mutation(fn.link, { submissionId: row.id, ...change });
  } catch (error) {
    throw writeRefusal(error, "Directory submission");
  }
  return v1Resource(c, linked);
});

const importSchema = z.strictObject({
  /** The version the caller read on the submission: refused when it names another by now. */
  pluginVersionId: z.string().trim().min(1).max(100).optional(),
});

evals.post(`${EVALS}/import`, async (c) => {
  const { pluginVersionId } = parseWithSchema(importSchema, await readJsonObjectBody(c));
  const version = pluginVersionId && idOf(pluginVersionId, "pluginVersionId", "Plugin version not found");
  const { convex, row } = await opened(c);
  let imported: EvalImport;
  try {
    imported = await convex.mutation(fn.import, {
      submissionId: row.id,
      ...(version ? { pluginVersionId: version } : {}),
    });
  } catch (error) {
    throw writeRefusal(error, "Eval suite");
  }
  return v1Resource(c, imported);
});

/** A suite's case as `testSuites:listTestCases` returns it. */
type StoredCase = {
  _id: string;
  title: string;
  query: string;
  isNegativeTest?: boolean;
  expectedOutput?: string;
  scenario?: string;
};

/**
 * ChatGPT's two lists: the cases a plugin should complete, and the negative
 * ones it should decline. The expectation is the expected output, else a
 * negative case's scenario, which says why it should decline. The form needs
 * both a prompt and an expectation, so a case without one is named instead.
 */
function portalCases(cases: readonly StoredCase[]) {
  const testCases = { successful: [] as PortalCase[], gracefulFailure: [] as PortalCase[] };
  const omitted: EvalExport["omitted"] = [];
  for (const { _id, title, query, isNegativeTest, expectedOutput, scenario } of cases) {
    const negative = isNegativeTest === true;
    const prompt = query.trim();
    const expectation = expectedOutput?.trim() || (negative && scenario?.trim()) || "";
    if (!prompt || !expectation) {
      omitted.push({ testCaseId: _id, title, negative, reason: prompt ? "no_expectation" : "no_prompt" });
      continue;
    }
    (negative ? testCases.gracefulFailure : testCases.successful).push({ prompt, expectation });
  }
  return { testCases, omitted };
}

evals.get(`${EVALS}/export`, async (c) => {
  const { convex, row } = await opened(c);
  const flow = flowOf(row);
  if (flow.directory !== "openai") {
    const message =
      "Claude's directory takes no test cases, so there is nothing to export. Add use cases with an example prompt each on the Use cases step instead.";
    throw new WebRouteError(409, ErrorCode.CONFLICT, message);
  }
  const { suite } = await readEvals(convex, row.id);
  if (!suite) {
    const message = "This submission has no eval suite. Link a suite in its project, then export its test cases.";
    throw new WebRouteError(409, ErrorCode.CONFLICT, message);
  }
  let cases: StoredCase[];
  try {
    cases = await convex.query(fn.cases, { suiteId: suite.id });
  } catch (error) {
    throw readRefusal(error, "Eval suite");
  }
  const { testCases, omitted } = portalCases(cases);
  const file: EvalExport = {
    submissionId: row.id,
    directory: flow.directory,
    suite,
    counts: { successful: testCases.successful.length, gracefulFailure: testCases.gracefulFailure.length },
    required: {
      successful: OPENAI_SUBMISSION_TEST_CASES.successCount,
      gracefulFailure: OPENAI_SUBMISSION_TEST_CASES.failureCount,
    },
    omitted,
    filename: `${flow.id}-${row.id}-test-cases.json`,
    mediaType: "application/json",
    // The file's own bytes, so every surface saves the same file.
    content: `${JSON.stringify(testCases, null, 2)}\n`,
  };
  return v1Resource(c, file);
});

export default evals;
