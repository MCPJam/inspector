/**
 * What the directory submission operation modules share: the submission
 * selector, the beta wording, the route they owe a permalink to, and how a
 * call finds its project. Exported only to those modules, never re-exported.
 */
import { z } from "zod";
import type { PlatformOperation, PlatformOperationContext } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { noPermalink } from "./permalinks.js";
import type { SelectedProjectInfo } from "./show-servers.js";

/** Writes and runs are gated on the beta; reads and the delete stay open. */
export const GATED_BETA =
  "In beta: an organization outside the directory readiness beta is refused, and the error names the feature.";
export const OPEN_BETA = "Directory readiness is in beta; this stays open to every organization.";

export const SUBMISSION_PERMALINK = noPermalink(
  "route-not-addressable",
  "No app route opens one submission yet: the Readiness page is behind a client flag and does not select a submission from its URL. Owed: `readiness?submission=:submissionId`."
);

export const id = () => z.string().trim().min(1);
export const project = id().optional().describe(PROJECT_SELECTOR_DESCRIPTION);

export const submissionInput = z.object({
  project,
  submission: id().describe("The submission's id, from list_directory_submissions."),
});

export type Op<TInput, TOutput> = PlatformOperation<TInput, TOutput>;
export type ProjectResult = { project: SelectedProjectInfo };

/** The project the input names, and the submission in it when there is one. */
export async function resolveScope(
  input: { project?: string; submission?: string },
  { client, signal, onScopeResolved }: PlatformOperationContext
) {
  const { project } = await resolveProjectOrThrow({ client, signal, onScopeResolved }, input.project);
  const scope = { projectId: project.id, submissionId: input.submission ?? "" };
  return { client, signal, project, scope, info: toSelectedProjectInfo(project) };
}
