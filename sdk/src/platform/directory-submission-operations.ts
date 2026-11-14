/**
 * The directory submission operations: read a directory's submission form,
 * keep a rehearsal of it for a saved server, and grade that rehearsal.
 *
 * Every answer carries who set it, through which channel and when. A write
 * names the revision it read, and the backend refuses it only when a field it
 * touches changed since. A run grades the answers as they were when it started.
 */
import { z } from "zod";
import { canonicalDigest } from "../contract/canonical.js";
import type { DirectoryFlow, PlacedStep } from "../directory-readiness/flows/types.js";
import type {
  PlatformDirectoryFlowSummary,
  PlatformDirectorySubmissionDeleted,
  PlatformDirectorySubmissionResults,
  PlatformDirectorySubmissionSummary,
  PlatformDirectorySubmissionView,
} from "./directory-submission-types.js";
import type { PlatformOperation, PlatformOperationContext } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveLiveServer,
  resolveProjectOrThrow,
  resolveSavedServer,
  serverScopedInput,
  toSelectedProjectInfo,
  toServerInfo,
  type ServerResult,
} from "./operation-support.js";
import { noPermalink } from "./permalinks.js";
import { operationInputError, resolutionError } from "./resource-selectors.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type { PlatformReadinessRunReceipt } from "./types.js";

/** Writes and runs are gated on the beta; reads and the delete stay open. */
const GATED_BETA =
  "In beta: an organization outside the directory readiness beta is refused, and the error names the feature.";
const OPEN_BETA = "Directory readiness is in beta; this stays open to every organization.";

const FLOW_PERMALINK = noPermalink(
  "no-addressable-resource",
  "A flow is a directory's submission form as product data, not a resource in anyone's project."
);
const SUBMISSION_PERMALINK = noPermalink(
  "route-not-addressable",
  "No app route opens one submission yet: the Readiness page is behind a client flag and does not select a submission from its URL. Owed: `readiness?submission=:submissionId`."
);

const id = () => z.string().trim().min(1);
const project = id().optional().describe(PROJECT_SELECTOR_DESCRIPTION);
const flowId = id().max(100);
const idempotencyKey = id().max(200).optional();

const submissionInput = z.object({
  project,
  submission: id().describe("The submission's id, from list_directory_submissions."),
});

const flowInput = z.object({
  flow: flowId.describe("The flow's id, such as `claude-connector`, from list_directory_flows."),
  step: id().optional().describe("Read only this step, such as `listing`. Omit for the whole flow."),
});

const createInput = serverScopedInput.extend({
  flow: flowInput.shape.flow,
  title: z.string().max(200).optional().describe("A name for this rehearsal."),
  idempotencyKey: idempotencyKey.describe(
    "Replay guard. A retry with the same key returns the submission it already created."
  ),
});

const listInput = z.object({
  project,
  server: id().optional().describe("Narrow to one saved server, by name or id."),
  flow: flowId.optional().describe("Narrow to one flow, such as `claude-connector`."),
  limit: z.number().int().min(1).max(100).optional().describe("Rows to return, 1-100."),
});

const answerValue = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])
  .or(z.array(z.record(z.string(), z.string())));

const updateInput = submissionInput.extend({
  answers: z.record(z.string().min(1).max(100), answerValue).optional().describe(
    "Values by field key from get_directory_flow, such as `listing.oneLiner`. `null` removes an answer."
  ),
  confirm: z.array(z.string().min(1).max(100)).max(200).optional().describe(
    "Declarations to confirm as true, by field key, under the wording the flow shows now."
  ),
  title: z.string().max(200).optional(),
  expectedRevision: z.number().int().min(1).optional().describe(
    "The `revision` you read. Omitted, the operation reads the current one first."
  ),
  idempotencyKey: idempotencyKey.describe(
    "Replay guard. Omitted, one is derived from the change and `expectedRevision`, so retrying the same change at the same revision is answered from the first write."
  ),
});

const startInput = submissionInput.extend({
  includeLlmObservations: z.boolean().optional().describe(
    "Ask a model for optional experience observations. Included with MCPJam; no customer credits consumed; subject to MCPJam's daily analysis budget."
  ),
  idempotencyKey: idempotencyKey.describe(
    "Replay guard. A retry with the same key returns the run it already started."
  ),
});

const resultsInput = submissionInput.extend({
  run: id().optional().describe("A completed run's id. Omit for the latest complete run."),
});

export type GetDirectoryFlowInput = z.infer<typeof flowInput>;
export type CreateDirectorySubmissionInput = z.infer<typeof createInput>;
export type ListDirectorySubmissionsInput = z.infer<typeof listInput>;
export type DirectorySubmissionScopedInput = z.infer<typeof submissionInput>;
export type UpdateDirectorySubmissionInput = z.infer<typeof updateInput>;
export type StartDirectorySubmissionRunInput = z.infer<typeof startInput>;
export type GetDirectorySubmissionResultsInput = z.infer<typeof resultsInput>;

type Op<TInput, TOutput> = PlatformOperation<TInput, TOutput>;
type ProjectResult = { project: SelectedProjectInfo };
export type ListDirectoryFlowsResult = { flows: PlatformDirectoryFlowSummary[] };
export type CreateDirectorySubmissionResult = ServerResult & {
  submission: PlatformDirectorySubmissionView;
};
export type ListDirectorySubmissionsResult = ProjectResult & {
  submissions: PlatformDirectorySubmissionSummary[];
};
export type DirectorySubmissionResult = ProjectResult & {
  submission: PlatformDirectorySubmissionView;
};
export type DeleteDirectorySubmissionResult = ProjectResult & PlatformDirectorySubmissionDeleted;
export type StartDirectorySubmissionRunResult = ProjectResult & {
  submissionId: string;
  run: PlatformReadinessRunReceipt;
};
export type GetDirectorySubmissionResultsResult = ProjectResult & {
  submissionId: string;
} & PlatformDirectorySubmissionResults;

/**
 * A finding's `details` is the raw observation behind it, which can dwarf
 * everything else in a result; a model surface would truncate the whole
 * payload over it. The full report stays on REST.
 */
function withoutFindingDetails<T extends { steps: PlacedStep[] }>(value: T): T {
  const steps = value.steps.map((step) => ({
    ...step,
    findings: step.findings.map((placed) => {
      const finding = { ...placed.finding };
      delete finding.details;
      return { ...placed, finding };
    }),
  }));
  return { ...value, steps };
}

/** The project the input names, and the submission in it when there is one. */
async function resolveScope(
  input: { project?: string; submission?: string },
  { client, signal, onScopeResolved }: PlatformOperationContext
) {
  const { project } = await resolveProjectOrThrow({ client, signal, onScopeResolved }, input.project);
  const scope = { projectId: project.id, submissionId: input.submission ?? "" };
  return { client, signal, project, scope, info: toSelectedProjectInfo(project) };
}

export const listDirectoryFlowsOperation: Op<Record<string, never>, ListDirectoryFlowsResult> = {
  name: "list_directory_flows",
  title: "List directory submission flows",
  description: `List the directory submission forms MCPJam can rehearse, such as Anthropic's connector directory (\`claude-connector\`): each flow's id, directory, title, the date of the portal capture it copies (\`version\`), the directory's real submission page, and its steps. Read one with get_directory_flow. ${OPEN_BETA}`,
  readOnly: true,
  permalink: FLOW_PERMALINK,
  inputSchema: z.object({}),
  async execute(_input, { client, signal }) {
    return { flows: (await client.listDirectoryFlows({ signal })).items };
  },
};

export const getDirectoryFlowOperation: Op<GetDirectoryFlowInput, DirectoryFlow> = {
  name: "get_directory_flow",
  title: "Get a directory submission flow",
  description: `Read one directory's submission form, field by field: each field's key, the portal's label and help, whether it is required, its limits, options and default, the portal's own error lines, and which MCPJam check reads which field. The field keys (\`listing.oneLiner\`) are what update_directory_submission takes. The whole flow is about 25 KB; pass \`step\` to read one step. ${OPEN_BETA}`,
  readOnly: true,
  permalink: FLOW_PERMALINK,
  inputSchema: flowInput,
  async execute(input, { client, signal }) {
    const flow = await client.getDirectoryFlow({ flowId: input.flow }, { signal });
    if (input.step === undefined) return flow;
    const step = flow.steps.find((candidate) => candidate.id === input.step);
    if (!step) {
      const ids = flow.steps.map((candidate) => candidate.id).join(", ");
      throw resolutionError(`Step "${input.step}" is not in ${flow.id}. Use one of: ${ids}.`);
    }
    const placements = flow.placements.filter((placement) => placement.step === step.id);
    return { ...flow, steps: [step], placements };
  },
};

export const createDirectorySubmissionOperation: Op<CreateDirectorySubmissionInput, CreateDirectorySubmissionResult> = {
  name: "create_directory_submission",
  title: "Create a directory submission",
  description: `Start a rehearsal of a directory's submission form for a saved MCP server: a submission that keeps the answers you would type into the portal. Fields the portal fills from your account start filled (origin \`account\`), and fields with a portal default read as origin \`default\` until someone sets them. Returns the submission with the portal's own checks over its answers. Nothing is sent to the directory. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: createInput,
  async execute(input, context) {
    const { client, signal, project, info } = await resolveScope(input, context);
    // A submission exists to be graded on the platform, so a server the
    // platform cannot dial is refused here, with the reason.
    const server = await resolveLiveServer(client, project, input.server, signal);
    const { flow: flowId, title, idempotencyKey } = input;
    const submission = await client.createDirectorySubmission(
      { projectId: project.id, flowId, serverId: server.id, title, idempotencyKey },
      { signal }
    );
    return { project: info, server: toServerInfo(server), submission: withoutFindingDetails(submission) };
  },
};

export const listDirectorySubmissionsOperation: Op<ListDirectorySubmissionsInput, ListDirectorySubmissionsResult> = {
  name: "list_directory_submissions",
  title: "List directory submissions",
  description: `List a project's directory submissions, newest first, optionally for one saved server or one flow: each one's id, flow, server, title, revision and last run. Answers are left out; read them with get_directory_submission. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: listInput,
  async execute(input, context) {
    const { client, signal, project, info } = await resolveScope(input, context);
    // Stored rows exist for any saved server, so the filter does not require
    // one the platform can dial.
    const serverId = input.server
      ? (await resolveSavedServer(client, project, input.server, signal)).id
      : undefined;
    const page = await client.listDirectorySubmissions(
      { projectId: project.id, serverId, flowId: input.flow, limit: input.limit },
      { signal }
    );
    return { project: info, submissions: page.items };
  },
};

export const getDirectorySubmissionOperation: Op<DirectorySubmissionScopedInput, DirectorySubmissionResult> = {
  name: "get_directory_submission",
  title: "Get a directory submission",
  description: `Read one directory submission: every answer with its value, its \`origin\` (\`account\`, \`default\`, \`set\`, \`confirmed\`, \`imported\` or \`reset\`), who set it (\`setBy\`, \`setByLabel\`, \`setVia\`) and when; the portal's own checks over the answers (\`fieldIssues\`); the latest complete run's findings grouped by the portal's steps (\`steps\`, without each finding's raw \`details\`); and \`revision\`, which update_directory_submission takes back as \`expectedRevision\`. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: submissionInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const submission = await client.getDirectorySubmission(scope, { signal });
    return { project: info, submission: withoutFindingDetails(submission) };
  },
};

export const updateDirectorySubmissionOperation: Op<UpdateDirectorySubmissionInput, DirectorySubmissionResult> = {
  name: "update_directory_submission",
  title: "Save answers to a directory submission",
  description: `Save answers to a directory submission. \`answers\` maps a field key from get_directory_flow to its value, and \`null\` removes an answer. \`confirm\` lists declarations (data handling, acknowledgments) to record as true under the wording the portal shows now: confirm one only when the person you work for says it is true. Each answer you write records you as its author, the channel and the time. Send the \`revision\` you read as \`expectedRevision\`: the write is refused with 409 only when a field you touch changed since, and the refusal names those \`conflictingKeys\` and carries the submission as it is now. To retry a call whose answer you did not get, send the same change with the same \`expectedRevision\` (or \`idempotencyKey\`): it is answered from the first write (\`replayed: true\`), not refused. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: updateInput,
  async execute(input, context) {
    // Here, not in the schema: the CLI calls `execute` without parsing.
    if (!input.answers && !input.confirm && input.title === undefined) {
      throw operationInputError("Nothing to save. Pass answers, confirm or title.");
    }
    const { client, signal, scope, info } = await resolveScope(input, context);
    const body = {
      expectedRevision:
        input.expectedRevision ?? (await client.getDirectorySubmission(scope, { signal })).revision,
      ...(input.answers ? { answers: input.answers } : {}),
      ...(input.confirm ? { confirm: input.confirm } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    };
    // Derived rather than random, so an identical retry of a call whose
    // answer was lost carries the same key, and the backend answers it from
    // the first write instead of refusing the fields that write changed.
    const key = input.idempotencyKey ?? `derived:${canonicalDigest({ ...scope, ...body })}`;
    const submission = await client.updateDirectorySubmission(
      { ...scope, ...body, idempotencyKey: key },
      { signal }
    );
    return { project: info, submission: withoutFindingDetails(submission) };
  },
};

export const deleteDirectorySubmissionOperation: Op<DirectorySubmissionScopedInput, DeleteDirectorySubmissionResult> = {
  name: "delete_directory_submission",
  title: "Delete a directory submission",
  description:
    "Delete a directory submission and every answer in it. This cannot be undone. Deleting stays open to every organization, in the directory readiness beta or not.",
  readOnly: false,
  risk: "destructive",
  permalink: noPermalink("mutation-only"),
  inputSchema: submissionInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    return { project: info, ...(await client.deleteDirectorySubmission(scope, { signal })) };
  },
};

export const startDirectorySubmissionRunOperation: Op<StartDirectorySubmissionRunInput, StartDirectorySubmissionRunResult> = {
  name: "start_directory_submission_run",
  title: "Run a directory submission's checks",
  description: `Grade a directory submission: its saved server against the directory's rules, and its answers against the portal's. Starts a durable run and returns a receipt, not a verdict; poll get_readiness_run with \`run.runId\` until it finishes, then read get_directory_submission_results. The run grades the answers as saved when it starts; later edits do not change it, and the results mark a finding whose answers changed since as \`stale\`. \`includeLlmObservations\` adds an optional model pass, included with MCPJam, so no customer credits are consumed; it is subject to MCPJam's daily analysis budget. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: startInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const { includeLlmObservations, idempotencyKey } = input;
    const run = await client.startDirectorySubmissionRun(
      { ...scope, includeLlmObservations, idempotencyKey },
      { signal }
    );
    return { project: info, submissionId: input.submission, run };
  },
};

export const getDirectorySubmissionResultsOperation: Op<GetDirectorySubmissionResultsInput, GetDirectorySubmissionResultsResult> = {
  name: "get_directory_submission_results",
  title: "Get a directory submission's results",
  description: `Read a directory submission's results grouped by the portal's steps: each step's field issues, and the findings placed under the field they read with an evidence status (\`established\`; \`stale\` when an answer the check read changed since the run; \`inconclusive\`, \`not-tested\` or \`blocked\`), plus totals in \`counts\`. Reads the latest complete run, or \`run\` when given; \`run\` is null before one completes. Each finding's raw \`details\` is left out. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: resultsInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const results = await client.getDirectorySubmissionResults({ ...scope, runId: input.run }, { signal });
    return { project: info, submissionId: input.submission, ...withoutFindingDetails(results) };
  },
};
