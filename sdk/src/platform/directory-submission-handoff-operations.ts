/**
 * Picking a directory submission up from its id alone: the handoff summary,
 * the findings page by page, one finding with its evidence, the export pack
 * and the recorded events. And the three records about what happened in the
 * directory itself, which MCPJam cannot see: a status, a snapshot of what a
 * catalog holds, and what the directory said.
 *
 * A record is what someone saw or relayed. MCPJam never makes one by itself,
 * each names who made it, and none is ever edited: a correction is a newer
 * record. No input here takes a secret's value.
 */
import { z } from "zod";
import { DIRECTORY_SNAPSHOT_LABELS } from "../directory-readiness/handoff.js";
import type { DirectoryReadinessFinding } from "../directory-readiness/types.js";
import type {
  PlatformDirectorySubmissionEvent as SubmissionEvent,
  PlatformDirectorySubmissionEventBody as EventBody,
  PlatformDirectorySubmissionExportFile,
  PlatformDirectorySubmissionFinding,
  PlatformDirectorySubmissionHandoff,
} from "./directory-submission-handoff-types.js";
import type { DirectorySubmissionScopedInput } from "./directory-submission-operations.js";
import {
  GATED_BETA,
  OPEN_BETA,
  SUBMISSION_PERMALINK,
  id,
  resolveScope,
  submissionInput,
  type Op,
  type ProjectResult,
} from "./directory-submission-operation-support.js";
import { resolveSavedServer } from "./operation-support.js";
import type { PlatformOperationContext } from "./operations.js";

const CHECK_STATUSES = [
  "violated",
  "satisfied",
  "not-evaluated",
  "not-applicable",
  "informational",
] as const satisfies readonly DirectoryReadinessFinding["status"][];
const EVENT_KINDS = [
  "status",
  "snapshot",
  "directory-finding",
  "credential",
  "answer-reset",
] as const satisfies readonly SubmissionEvent["kind"][];
/** The stages a directory moves a submission through. The backend refuses any other. */
const STATUSES = [
  "submitted",
  "in-review",
  "changes-requested",
  "approved",
  "rejected",
  "published",
  "withdrawn",
] as const;
const NO_SECRETS = "Text that looks like a credential is refused: name the project secret instead.";

const text = (max: number) => z.string().max(max);
const epochMs = z.number().positive();

const findingsInput = submissionInput.extend({
  status: z.enum(CHECK_STATUSES).optional().describe("Only findings with this status, such as `violated`."),
  step: id().max(100).optional().describe("Only findings shown at this portal step, by its id from get_directory_flow."),
  lane: id().max(100).optional().describe("Only findings from this lane, such as `directory-policy`."),
  cursor: z.string().min(1).max(2048).optional().describe("The `nextCursor` of the page before, unchanged."),
  limit: z.number().int().min(1).max(100).optional().describe("Findings per page, 1-100. Defaults to 25."),
});

const findingInput = submissionInput.extend({
  check: id().max(120).describe("The check's id, such as `claude.endpoint.https`: a finding's or a blocker's `checkId`."),
});

const exportInput = submissionInput.extend({
  format: z.enum(["json", "markdown"]).optional().describe(
    "`json` (the default) for a program, `markdown` for a person to read or paste into a ticket."
  ),
});

const eventsInput = submissionInput.extend({
  kind: z.enum(EVENT_KINDS).optional().describe("Only events of this kind."),
  limit: z.number().int().min(1).max(100).optional().describe("Events to return, 1-100."),
});

const evidence = z
  .object({ kind: z.enum(["url", "text", "run"]), value: z.string().min(1).max(4000) })
  .optional()
  .describe("What shows it: an https `url`, quoted `text`, or the id of a `run`.");

const recordInput = submissionInput.extend({
  reportedOrObserved: z.enum(["reported", "observed"]).optional().describe(
    "`observed` when you saw it first hand, `reported` when someone told you. Omitted, it is recorded as `reported`."
  ),
  idempotencyKey: id().max(200).optional().describe(
    "Replay guard. A retry with the same key returns the event it already recorded."
  ),
});

const statusInput = recordInput.extend({
  state: z.enum(STATUSES).describe("Where the directory has the submission now."),
  directoryLabel: text(200).optional().describe("The directory's own words for the state, verbatim."),
  uncertain: z.boolean().optional().describe(
    "The portal's outcome was unclear, such as a submit dialog that stayed busy."
  ),
  link: text(2048).optional().describe("An https link to the submission in the directory."),
  reference: text(200).optional().describe("A confirmation reference the directory gave."),
  detail: text(4000).optional().describe("Anything else the next person should know, in plain words."),
  evidence,
});

const snapshotInput = recordInput.extend({
  label: z.enum(DIRECTORY_SNAPSHOT_LABELS).describe(
    "Which copy: `candidate` (about to ship), `production` (live), `directory` (what the directory's client holds) or `published` (what was submitted or published)."
  ),
  server: id().optional().describe("The saved server the copy is of, by name or id. Defaults to the submission's own."),
  revisionNumber: z.number().int().min(1).optional().describe(
    "The server revision the copy holds, from list_server_revisions. Without one, what it holds stays unknown."
  ),
  capturedAt: epochMs.optional().describe("When the copy was seen, in epoch milliseconds."),
  note: text(4000).optional().describe("How you know, such as what the portal's tool list showed."),
  evidence,
});

const directoryFindingInput = recordInput.extend({
  text: z.string().min(1).max(4000).describe("What the directory said, verbatim: paste its words unchanged."),
  via: z.enum(["email", "portal", "other"]).describe("How it arrived."),
  severity: text(200).optional().describe("The directory's own severity, as given."),
  code: text(200).optional().describe("The directory's code for it, as given."),
  version: text(200).optional().describe("The version of the submission it is about."),
  receivedAt: epochMs.optional().describe("When it arrived, in epoch milliseconds."),
  link: text(2048).optional().describe("An https link to the message, if it has one."),
});

export type ListDirectorySubmissionFindingsInput = z.infer<typeof findingsInput>;
export type GetDirectorySubmissionFindingInput = z.infer<typeof findingInput>;
export type ExportDirectorySubmissionInput = z.infer<typeof exportInput>;
export type ListDirectorySubmissionEventsInput = z.infer<typeof eventsInput>;
export type RecordDirectorySubmissionStatusInput = z.infer<typeof statusInput>;
export type RecordDirectorySubmissionSnapshotInput = z.infer<typeof snapshotInput>;
export type ImportDirectoryFindingInput = z.infer<typeof directoryFindingInput>;

type SubmissionResult = ProjectResult & { submissionId: string };
export type GetDirectorySubmissionHandoffResult = ProjectResult & PlatformDirectorySubmissionHandoff;
export type ListDirectorySubmissionFindingsResult = SubmissionResult & {
  findings: PlatformDirectorySubmissionFinding[];
  /** Absent on the last page. */
  nextCursor?: string;
};
export type GetDirectorySubmissionFindingResult = SubmissionResult & {
  finding: PlatformDirectorySubmissionFinding;
};
export type ExportDirectorySubmissionResult = SubmissionResult & PlatformDirectorySubmissionExportFile;
export type ListDirectorySubmissionEventsResult = SubmissionResult & { events: SubmissionEvent[] };
export type RecordDirectorySubmissionEventResult = ProjectResult & { event: SubmissionEvent };

type Resolved = Awaited<ReturnType<typeof resolveScope>>;
type EventFields = Omit<EventBody, "reportedOrObserved" | "idempotencyKey">;

/** Record one event in the submission's project, with what every record shares. */
async function record(
  input: z.infer<typeof recordInput>,
  context: PlatformOperationContext,
  event: (resolved: Resolved) => EventFields | Promise<EventFields>
): Promise<RecordDirectorySubmissionEventResult> {
  const resolved = await resolveScope(input, context);
  const { client, signal, scope, info } = resolved;
  const body = {
    ...(await event(resolved)),
    // Relayed is the weaker claim, so it is the one made when nobody says.
    reportedOrObserved: input.reportedOrObserved ?? "reported",
    idempotencyKey: input.idempotencyKey,
  };
  return { project: info, event: await client.recordDirectorySubmissionEvent({ ...scope, ...body }, { signal }) };
}

export const getDirectorySubmissionHandoffOperation: Op<DirectorySubmissionScopedInput, GetDirectorySubmissionHandoffResult> = {
  name: "get_directory_submission_handoff",
  title: "Get a directory submission's handoff summary",
  description: `The first call when you pick up a directory submission from its id or a link, with no history: where it stands, built from the record on every read. From a link, send its \`project\` and \`submission\` values. Returns the latest \`status\` someone recorded (MCPJam never sets one), the first portal step with work left (\`currentStep\`), \`counts\` by evidence status and by step, the \`verdict\` under the submission's gate with the first \`blockers\` by step and field, \`unconfirmedDeclarations\`, \`missingRequired\` and \`invalidAnswers\`, reviewer \`credentials\` by secret name (never a value), the latest snapshot per label and which differ, \`nextActions\` (each an operation and the input to send it), \`remainingPortalActions\` (what only a person can do in the directory's portal), what is still unknown, and \`links\`. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: submissionInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    return { project: info, ...(await client.getDirectorySubmissionHandoff(scope, { signal })) };
  },
};

export const listDirectorySubmissionFindingsOperation: Op<ListDirectorySubmissionFindingsInput, ListDirectorySubmissionFindingsResult> = {
  name: "list_directory_submission_findings",
  title: "List a directory submission's findings",
  description: `Page through a directory submission's stored findings, newest first: each check's latest result with its status, lane, the portal step and field it shows at, and the run that wrote it. The observation behind a finding is left out; \`hasDetails\` says whether get_directory_submission_finding has one. Filter by \`status\`, \`step\` or \`lane\`, and pass \`nextCursor\` back as \`cursor\` until it is absent: every finding is reachable however many there are. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: findingsInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const { status, step, lane, cursor, limit } = input;
    const page = await client.listDirectorySubmissionFindings({ ...scope, status, step, lane, cursor, limit }, { signal });
    return {
      project: info,
      submissionId: input.submission,
      findings: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

export const getDirectorySubmissionFindingOperation: Op<GetDirectorySubmissionFindingInput, GetDirectorySubmissionFindingResult> = {
  name: "get_directory_submission_finding",
  title: "Get one directory submission finding",
  description: `Read one check's stored result on a directory submission with the observation behind it (\`details\`, at most 8 KiB; \`detailsTruncated\` says when it was cut). Read a blocker this way to see exactly what it found before you fix it. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: findingInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const finding = await client.getDirectorySubmissionFinding({ ...scope, checkId: input.check }, { signal });
    return { project: info, submissionId: input.submission, finding };
  },
};

export const exportDirectorySubmissionOperation: Op<ExportDirectorySubmissionInput, ExportDirectorySubmissionResult> = {
  name: "export_directory_submission",
  title: "Export a directory submission",
  description: `Export a directory submission as the pack its team receives: the handoff summary, every answer in form order with who set it, every finding without its raw observation, what the directory said, the status history, the steps only a person can take in the portal, and what is still unknown. A secret appears only as the name of the project secret that holds it. \`content\` is the file's exact bytes, the same the page and the CLI save; keep it as is under \`filename\`. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: exportInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const file = await client.exportDirectorySubmission({ ...scope, format: input.format }, { signal });
    return { project: info, submissionId: input.submission, ...file };
  },
};

export const listDirectorySubmissionEventsOperation: Op<ListDirectorySubmissionEventsInput, ListDirectorySubmissionEventsResult> = {
  name: "list_directory_submission_events",
  title: "List a directory submission's events",
  description: `List what was recorded about a directory submission outside MCPJam, newest first, at most 100: statuses, snapshots, what the directory said (\`directory-finding\`), reviewer credential states and answer resets. Each names who recorded it (\`actor\`, with \`actorLabel\` for an agent), when, and whether it was \`reported\` or \`observed\`. ${OPEN_BETA}`,
  readOnly: true,
  permalink: SUBMISSION_PERMALINK,
  inputSchema: eventsInput,
  async execute(input, context) {
    const { client, signal, scope, info } = await resolveScope(input, context);
    const page = await client.listDirectorySubmissionEvents({ ...scope, kind: input.kind, limit: input.limit }, { signal });
    return { project: info, submissionId: input.submission, events: page.items };
  },
};

export const recordDirectorySubmissionStatusOperation: Op<RecordDirectorySubmissionStatusInput, RecordDirectorySubmissionEventResult> = {
  name: "record_directory_submission_status",
  title: "Record a directory submission's status",
  description: `Record where the directory has a submission, as the directory showed it or as someone told you: \`state\` is the stage, and \`directoryLabel\` keeps the directory's own words. Mark \`uncertain\` when the portal's outcome was unclear, such as a submit dialog that stayed busy, so nobody retries before checking. Add the \`link\`, the directory's confirmation \`reference\` and \`evidence\` when you have them. MCPJam never sets a status by itself. A record names you and the time and is never edited; record a new one to correct it. ${NO_SECRETS} ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: statusInput,
  execute(input, context) {
    const { state, uncertain, directoryLabel, link, reference, detail, evidence } = input;
    return record(input, context, () => ({
      kind: "status",
      state,
      uncertain,
      directoryLabel,
      link,
      reference,
      detail,
      evidence,
    }));
  },
};

export const recordDirectorySubmissionSnapshotOperation: Op<RecordDirectorySubmissionSnapshotInput, RecordDirectorySubmissionEventResult> = {
  name: "record_directory_submission_snapshot",
  title: "Record a directory submission snapshot",
  description: `Record which revision of a saved server one copy of its catalog holds. MCPJam cannot read what a directory holds, so a \`directory\` or \`published\` copy is what someone saw in the portal or told you. Name the revision from list_server_revisions as \`revisionNumber\`; get_directory_submission_handoff then compares neighbouring copies and says when a fix has not reached the directory. ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: snapshotInput,
  execute(input, context) {
    const { label, revisionNumber, capturedAt, note } = input;
    return record(input, context, async ({ client, project, signal }) => {
      // Omitted, the route takes the submission's own server.
      const server = input.server ? await resolveSavedServer(client, project, input.server, signal) : undefined;
      const snapshot = { label, serverId: server?.id, revisionNumber, capturedAt, note };
      return { kind: "snapshot", evidence: input.evidence, snapshot };
    });
  },
};

export const importDirectoryFindingOperation: Op<ImportDirectoryFindingInput, RecordDirectorySubmissionEventResult> = {
  name: "import_directory_finding",
  title: "Import what a directory said",
  description: `Keep what a directory said about a submission, such as a rejection reason or a reviewer's email, in its own words with its date and version. It stays apart from MCPJam's findings and is never merged with them. ${NO_SECRETS} ${GATED_BETA}`,
  readOnly: false,
  risk: "none",
  permalink: SUBMISSION_PERMALINK,
  inputSchema: directoryFindingInput,
  execute(input, context) {
    const { text: said, via, severity, code, version, receivedAt } = input;
    return record(input, context, () => ({
      kind: "directory-finding",
      link: input.link,
      finding: { text: said, via, severity, code, version, receivedAt },
    }));
  },
};
