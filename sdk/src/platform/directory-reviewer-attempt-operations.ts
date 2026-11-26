/**
 * Reviewer sign-in attempts: MCPJam signs in to a directory submission's
 * server as the directory's reviewer, with credentials the project keeps as
 * secrets, and records each stage on the attempt. Inputs take secret NAMES
 * only, and refuse any field they do not name: a credential's value never
 * belongs in a call an agent makes.
 */
import { z } from "zod";
import type {
  PlatformReviewerAttempt,
  PlatformReviewerAttemptStart,
} from "./directory-reviewer-attempt-types.js";
import type { PlatformOperation, PlatformOperationContext } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { noPermalink } from "./permalinks.js";
import { SUBMISSION_PERMALINK } from "./directory-submission-operation-support.js";
import type { SelectedProjectInfo } from "./show-servers.js";

const GATED_BETA =
  "In beta: an organization outside the directory readiness beta is refused, and the error names the feature.";
const OPEN_BETA = "Directory readiness is in beta; this stays open to every organization.";
const id = () => z.string().trim().min(1);
const secretName = () => z.string().trim().max(64).regex(/^[A-Z_][A-Z0-9_]*$/);
const submissionInput = z.strictObject({
  project: id().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
  submission: id().describe("The submission's id, from list_directory_submissions."),
});
const attemptInput = submissionInput.extend({
  attempt: id().describe("The attempt's id, from list_reviewer_attempts."),
});
const createInput = submissionInput.extend({
  passwordSecretName: secretName().describe(
    "The NAME of the project secret holding the reviewer's password, such as `MCPJAM_REVIEWER_ACME_PASSWORD`. Never the password."
  ),
  usernameSecretName: secretName().optional().describe(
    "The NAME of the project secret holding the reviewer's username, when it is kept as a secret."
  ),
  username: z.string().trim().min(1).max(320).optional().describe(
    "The reviewer's username as plain text, such as `review@example.com`, when it is not a secret."
  ),
  loginUrl: z.string().trim().max(2048).optional().describe("The https sign-in page, when the reviewer starts there."),
  tenant: z.string().trim().min(1).max(320).optional().describe(
    "The organization or tenant the reviewer must end up signed in to."
  ),
  idempotencyKey: id().max(200).optional().describe(
    "Replay guard. A retry with the same key returns the attempt it already started, and its run."
  ),
});
const listInput = submissionInput.extend({
  limit: z.number().int().min(1).max(50).optional().describe("Attempts to return, 1-50, newest first."),
});

export type CreateReviewerAttemptInput = z.infer<typeof createInput>;
export type ListReviewerAttemptsInput = z.infer<typeof listInput>;
export type ReviewerAttemptScopedInput = z.infer<typeof attemptInput>;

type Op<TInput, TOutput> = PlatformOperation<TInput, TOutput>;
type Scoped = { project: SelectedProjectInfo; submissionId: string };
export type ReviewerAttemptStartResult = Scoped & PlatformReviewerAttemptStart;
export type ReviewerAttemptResult = Scoped & { attempt: PlatformReviewerAttempt };
export type ListReviewerAttemptsResult = Scoped & { attempts: PlatformReviewerAttempt[] };

async function resolveScope(
  input: { project?: string; submission: string },
  { client, signal, onScopeResolved }: PlatformOperationContext
) {
  const { project } = await resolveProjectOrThrow({ client, signal, onScopeResolved }, input.project);
  const scope = { projectId: project.id, submissionId: input.submission };
  const scoped = { project: toSelectedProjectInfo(project), submissionId: input.submission };
  return { client, signal, scope, scoped };
}

export const createReviewerAttemptOperation: Op<CreateReviewerAttemptInput, ReviewerAttemptStartResult> = {
  name: "create_reviewer_attempt",
  title: "Start a reviewer sign-in attempt",
  description: `Start MCPJam signing in to a directory submission's saved server as the directory's reviewer, from a clean hosted browser, and the readiness run that does it. Pass secret NAMES only: first save the password as a materialized project secret whose name starts with \`MCPJAM_REVIEWER_\` (Secrets page, or REST, SDK or CLI; the value is write-only and nothing returns it), then name it here. Records "credentials saved" on the submission and returns the attempt and its run. Read it with get_reviewer_attempt: \`state\` is running, waiting-for-person (a person acts, then resume_reviewer_attempt), passed, failed, expired or cancelled, and \`stages\` say how far it got. One attempt per submission is open at a time. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: createInput,
  async execute(input, context) {
    const { client, signal, scope, scoped } = await resolveScope(input, context);
    const { passwordSecretName, usernameSecretName, username, loginUrl, tenant, idempotencyKey } = input;
    const started = await client.createDirectoryReviewerAttempt(
      { ...scope, passwordSecretName, usernameSecretName, username, loginUrl, tenant, idempotencyKey },
      { signal }
    );
    return { ...scoped, ...started };
  },
};

export const listReviewerAttemptsOperation: Op<ListReviewerAttemptsInput, ListReviewerAttemptsResult> = {
  name: "list_reviewer_attempts",
  title: "List reviewer sign-in attempts",
  description: `List a directory submission's reviewer sign-in attempts, newest first: each one's state, stages, the secret names it signs in with and the runs that worked on it. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: listInput,
  async execute(input, context) {
    const { client, signal, scope, scoped } = await resolveScope(input, context);
    const page = await client.listDirectoryReviewerAttempts({ ...scope, limit: input.limit }, { signal });
    return { ...scoped, attempts: page.items };
  },
};

export const getReviewerAttemptOperation: Op<ReviewerAttemptScopedInput, ReviewerAttemptResult> = {
  name: "get_reviewer_attempt",
  title: "Get a reviewer sign-in attempt",
  description: `Read one reviewer sign-in attempt: its \`state\`, each stage with its status and evidence (screenshot and recording ids, the identity and organization observed, an HTTP status), \`waitingFor\` (why it stopped for a person and what they should do), \`testedAt\` once sign-in and connect passed, and \`expiresAt\`. Never a secret's value. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: attemptInput,
  async execute(input, context) {
    const { client, signal, scope, scoped } = await resolveScope(input, context);
    const attempt = await client.getDirectoryReviewerAttempt({ ...scope, attemptId: input.attempt }, { signal });
    return { ...scoped, attempt };
  },
};

export const resumeReviewerAttemptOperation: Op<ReviewerAttemptScopedInput, ReviewerAttemptStartResult> = {
  name: "resume_reviewer_attempt",
  title: "Resume a reviewer sign-in attempt",
  description: `Continue a reviewer sign-in attempt that is waiting for a person, once the person did what its \`waitingFor.action\` says: starts a new run that carries on the same attempt, and returns both. Refused unless the attempt is waiting-for-person and has not expired. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: attemptInput,
  async execute(input, context) {
    const { client, signal, scope, scoped } = await resolveScope(input, context);
    const resumed = await client.resumeDirectoryReviewerAttempt({ ...scope, attemptId: input.attempt }, { signal });
    return { ...scoped, ...resumed };
  },
};

export const cancelReviewerAttemptOperation: Op<ReviewerAttemptScopedInput, ReviewerAttemptResult> = {
  name: "cancel_reviewer_attempt",
  title: "Cancel a reviewer sign-in attempt",
  description:
    "Stop a reviewer sign-in attempt that is running or waiting for a person. The run working on it can no longer record stages, and a new attempt can start. Cancelling stays open to every organization, in the directory readiness beta or not.",
  readOnly: false,
  risk: "none",
  permalink: noPermalink("mutation-only"),
  inputSchema: attemptInput,
  async execute(input, context) {
    const { client, signal, scope, scoped } = await resolveScope(input, context);
    const attempt = await client.cancelDirectoryReviewerAttempt({ ...scope, attemptId: input.attempt }, { signal });
    return { ...scoped, attempt };
  },
};

export const createReviewerHandoffOperation: Op<ReviewerAttemptScopedInput, Scoped & { handoffUrl: string; expiresAt: number }> = {
  name: "create_reviewer_handoff",
  title: "Finish reviewer sign-in in a browser",
  description: "Create a single-use sign-in link for a paused reviewer attempt. Only the person who started its latest run can open the link. They complete sign-in in their browser, then any authorized agent can resume the same attempt. A new link invalidates the previous one.",
  readOnly: false,
  risk: "none",
  permalink: noPermalink("external-resource", "The response carries a requester-only single-use authorization link, which is not a shareable resource permalink."),
  inputSchema: attemptInput,
  async execute(input, context) {
    const { client, signal, scope, scoped } = await resolveScope(input, context);
    const handoff = await client.createDirectoryReviewerHandoff({ ...scope, attemptId: input.attempt }, { signal });
    return { ...scoped, ...handoff };
  },
};
