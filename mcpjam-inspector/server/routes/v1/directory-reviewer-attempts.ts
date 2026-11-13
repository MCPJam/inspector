/**
 * Public `/api/v1` reviewer sign-in attempts: MCPJam signing in as a
 * directory's reviewer for one submission, with reviewer credentials the
 * project saved as secrets.
 *
 * SECRET NAMES ONLY. A key a body does not take, or a plain field holding
 * something credential-shaped, is refused without quoting it back.
 *
 * Starting and resuming each start the readiness run that works on the
 * attempt. The worker gets the attempt in memory: the backend run takes no
 * attempt id, and a resumed run finds its attempt by the run it names.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import type {
  PlatformDirectorySubmission as Submission,
  PlatformReviewerAttempt as Attempt,
} from "@mcpjam/sdk/platform";
import { redactSecretShapes } from "../../../shared/secret-shape-redaction.js";
import { authorizeServer } from "../web/auth.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { captureServerEvent } from "../../utils/analytics.js";
import { REVIEWER_SECRET_PREFIX } from "../../utils/secrets/reviewer-secrets.js";
import {
  startHostedReadinessRun,
  type AuthorizedReadinessServer,
} from "../shared/readiness-runs.js";
import {
  ATTEMPT_NOT_FOUND,
  readReviewerAttempt,
  reviewerAttemptFunctions as fn,
} from "../shared/reviewer-attempts.js";
import { readinessAnalyticsActor } from "./readiness.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { requireConvexIdShape } from "./convex-id-param.js";
import { convexErrorData, translateConvexWriteError } from "./convex-errors.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { flowOf, readSubmission, scopeOf } from "./directory-submissions.js";
import { readRefusal } from "./directory-submission-views.js";

const reviewerAttempts = new Hono();

const RESOURCE = "Reviewer attempt";
const BASE = "/projects/:projectId/directory-submissions/:submissionId/reviewer-attempts";
const ONE = `${BASE}/:attemptId`;

const secretName = z
  .string()
  .trim()
  .max(64)
  .regex(
    new RegExp(`^${REVIEWER_SECRET_PREFIX}[A-Z0-9_]+$`),
    `Send the name of a project secret that starts with ${REVIEWER_SECRET_PREFIX}, such as ${REVIEWER_SECRET_PREFIX}ACME_PASSWORD. Chat sessions never receive those secrets.`,
  );
const plain = z.string().trim().min(1).max(320);
const createSchema = z.strictObject({
  passwordSecretName: secretName,
  usernameSecretName: secretName.optional(),
  username: plain.optional(),
  loginUrl: z.url({ protocol: /^https$/ }).max(2048).optional(),
  tenant: plain.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});
/** Resume and cancel take no body: the path names the attempt. */
const emptySchema = z.strictObject({});

const REFERENCE_KEYS = new Set(["passwordSecretName", "usernameSecretName"]);
const PLAIN_KEYS = new Set(["username", "loginUrl", "tenant", "idempotencyKey"]);

/** Refuses a key the body does not take, and a credential-shaped plain field. */
function refuseCredentialValues(body: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(body)) {
    if (REFERENCE_KEYS.has(key)) continue;
    const shaped = typeof value === "string" && redactSecretShapes(value) !== value;
    if (PLAIN_KEYS.has(key) && !shaped) continue;
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `${key}: reviewer credentials travel only as project secret names, so nothing was saved. Save the value on the project's Secrets page, then send its name as passwordSecretName or usernameSecretName.`,
    );
  }
}

/** The attempt's refusals a caller acts on, by status. */
const ATTEMPT_REFUSALS: Readonly<Record<string, 400 | 409>> = {
  secret_not_found: 400,
  secret_not_materialized: 400,
  secret_ambiguous: 400,
  attempt_open: 409,
  attempt_expired: 409,
  attempt_not_waiting: 409,
  attempt_ended: 409,
  idempotency_key_reused: 409,
};

function attemptWriteError(error: unknown): Error {
  const data = convexErrorData(error) as Record<string, unknown> | null;
  const code = typeof data?.code === "string" ? data.code : "";
  const status = ATTEMPT_REFUSALS[code];
  if (!status || typeof data?.message !== "string") {
    return translateConvexWriteError(error, { resource: RESOURCE });
  }
  // Copied key by key: the rest of the payload is the backend's own shape.
  const details: Record<string, unknown> = { code };
  for (const key of ["secretName", "attemptId", "state"]) {
    if (typeof data[key] === "string") details[key] = data[key];
  }
  const kind = status === 409 ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_ERROR;
  return new WebRouteError(status, kind, data.message, details);
}

const translateRead = (error: unknown) => readRefusal(error, RESOURCE);

function attemptScope(c: Context) {
  const attemptId = requireConvexIdShape(c.req.param("attemptId"), "attemptId", {
    scope: "v1.directory-submissions",
    notFoundMessage: ATTEMPT_NOT_FOUND,
  });
  return { scope: scopeOf(c), attemptId };
}

function savedServerOf(row: Submission): string {
  if (row.serverId) return row.serverId;
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    "This submission has no saved server for the reviewer to sign in to. Create a submission for a saved server, then start the sign-in.",
  );
}

/**
 * Start the run that works on the attempt. Its key comes from the attempt, so
 * a replayed start finds the run the first one started instead of signing in
 * twice. A start that fails leaves the attempt open, and names it.
 */
async function startAttemptRun(
  c: Context,
  convex: ConvexHttpClient,
  row: Submission,
  attempt: Attempt,
  authorized: AuthorizedReadinessServer,
  runKey: string,
) {
  const flow = flowOf(row);
  try {
    const receipt = await startHostedReadinessRun({
      convex,
      projectId: row.projectId,
      serverId: savedServerOf(row),
      publisher: flow.directory,
      idempotencyKey: runKey,
      includeLlmObservations: false,
      submissionId: row.id,
      reviewerAttemptId: attempt.id,
      authorized,
      analyticsActor: readinessAnalyticsActor(c, row.projectId),
      translateError: (error) => translateConvexWriteError(error, { resource: "Readiness run" }),
    });
    captureServerEvent(c, "directory_readiness_run_started_server", {
      readiness_kind: flow.directory,
      submission_mode: null,
      flow_id: flow.id,
      include_llm_observations: false,
      deduped: receipt.deduped,
      run_status: receipt.status,
    });
    return receipt;
  } catch (error) {
    if (error instanceof WebRouteError) error.details = { ...error.details, attemptId: attempt.id };
    throw error;
  }
}

reviewerAttempts.post(BASE, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const raw = await readJsonObjectBody(c);
  refuseCredentialValues(raw);
  const { idempotencyKey, ...names } = parseWithSchema(createSchema, raw);
  const token = await getConvexBearerForRequest(c);
  const convex = createConvexClient(token);
  const row = await readSubmission(convex, projectId, submissionId);
  // Before anything is written: a server the caller cannot use leaves no attempt.
  const authorized = await authorizeServer(c, token, projectId, savedServerOf(row));
  let created: Attempt & { replayed?: true };
  try {
    created = await convex.mutation(fn.create, {
      submissionId,
      ...names,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    throw attemptWriteError(error);
  }
  const { replayed, ...attempt } = created;
  // A replay of an attempt that has since ended starts nothing.
  const run =
    attempt.state === "running"
      ? await startAttemptRun(c, convex, row, attempt, authorized, `reviewer-attempt:${attempt.id}`)
      : null;
  return v1Resource(c, { attempt, run, ...(replayed ? { replayed } : {}) }, 201);
});

reviewerAttempts.get(BASE, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 50)) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "limit must be an integer between 1 and 50");
  }
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  await readSubmission(convex, projectId, submissionId);
  let rows: Attempt[] | null;
  try {
    rows = await convex.query(fn.list, { submissionId, ...(limit ? { limit } : {}) });
  } catch (error) {
    throw readRefusal(error, "Reviewer attempts");
  }
  return v1PageJson(c, rows ?? []);
});

reviewerAttempts.get(ONE, async (c) => {
  const { scope, attemptId } = attemptScope(c);
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  return v1Resource(c, await readReviewerAttempt(convex, scope, attemptId, translateRead));
});

/** Hand an attempt waiting for a person to a new run. */
reviewerAttempts.post(`${ONE}/resume`, async (c) => {
  const { scope, attemptId } = attemptScope(c);
  parseWithSchema(emptySchema, await readJsonObjectBody(c));
  const token = await getConvexBearerForRequest(c);
  const convex = createConvexClient(token);
  const row = await readSubmission(convex, scope.projectId, scope.submissionId);
  await readReviewerAttempt(convex, scope, attemptId, translateRead);
  const authorized = await authorizeServer(c, token, scope.projectId, savedServerOf(row));
  let attempt: Attempt;
  try {
    attempt = await convex.mutation(fn.resume, { attemptId });
  } catch (error) {
    throw attemptWriteError(error);
  }
  const runKey = `reviewer-attempt:${attempt.id}:${attempt.resumedAt ?? attempt.updatedAt}`;
  const run = await startAttemptRun(c, convex, row, attempt, authorized, runKey);
  return v1Resource(c, { attempt, run }, 202);
});

reviewerAttempts.post(`${ONE}/cancel`, async (c) => {
  const { scope, attemptId } = attemptScope(c);
  parseWithSchema(emptySchema, await readJsonObjectBody(c));
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  await readReviewerAttempt(convex, scope, attemptId, translateRead);
  try {
    return v1Resource(c, await convex.mutation(fn.cancel, { attemptId }));
  } catch (error) {
    throw attemptWriteError(error);
  }
});

export default reviewerAttempts;
