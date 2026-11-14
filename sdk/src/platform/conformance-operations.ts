/**
 * The conformance run operations: start a hosted run on a saved server, read
 * it, list a project's runs and read the bounded failing-check projection.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  SERVER_SELECTOR_DESCRIPTION,
  resolveLiveServer,
  resolveProjectOrThrow,
  serverScopedInput,
  toSelectedProjectInfo,
  toServerInfo,
  type ResolvedServerInfo,
} from "./operation-support.js";
import { derivePermalinks } from "./permalinks.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type {
  PlatformConformanceCheck,
  PlatformConformanceReport,
  PlatformConformanceRun,
  PlatformConformanceRunReceipt,
} from "./conformance-types.js";

const conformanceRunScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  run: z.string().trim().min(1).describe("The conformance run's id."),
});

export type ConformanceRunScopedInput = z.infer<
  typeof conformanceRunScopedInput
>;

const startConformanceRunInput = serverScopedInput.extend({
  suites: z
    .array(z.enum(["protocol", "apps", "tasks"]))
    .min(1)
    .optional()
    .describe(
      "Suites to run. Defaults to protocol, apps, and tasks. OAuth is not available on this surface."
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Replay guard. A retry carrying the same key returns the run it already started rather than dialling the target twice."
    ),
  protocolVersion: z.string().trim().min(1).optional(),
  engineVersion: z.string().trim().min(1).optional(),
  settings: z
    .enum(["saved", "none"])
    .optional()
    .describe(
      'Which settings the run uses. "saved", the default, runs the checks, advice and tool inputs saved for this server; "none" runs every check with no tool inputs.'
    ),
});

export type StartConformanceRunInput = z.infer<typeof startConformanceRunInput>;

export type StartConformanceRunResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  run: PlatformConformanceRunReceipt;
};

export const startConformanceRunOperation: PlatformOperation<
  StartConformanceRunInput,
  StartConformanceRunResult
> = {
  name: "start_conformance_run",
  title: "Start a conformance run",
  description:
    "Run the protocol, apps, and tasks conformance suites against a saved MCP server, with the checks and tool inputs saved for it. Starts a durable run and returns its id; the verdict is available on the run after completion, not in this response. OAuth is not available here. Status, outcome, and score are three different answers.",
  readOnly: false,
  risk: "none",
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.run.runId,
      projectId: result.run.projectId,
    },
  ]),
  inputSchema: startConformanceRunInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const run = await client.startConformanceRun(
      {
        projectId: project.id,
        serverId: server.id,
        ...(input.suites ? { suites: input.suites } : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        ...(input.protocolVersion
          ? { protocolVersion: input.protocolVersion }
          : {}),
        ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
        ...(input.settings ? { settings: input.settings } : {}),
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      run,
    };
  },
};

export type GetConformanceRunResult = {
  project: SelectedProjectInfo;
  run: PlatformConformanceRun;
};

export const getConformanceRunOperation: PlatformOperation<
  ConformanceRunScopedInput,
  GetConformanceRunResult
> = {
  name: "get_conformance_run",
  title: "Get a conformance run",
  description:
    "Read one persisted conformance run. THREE SEPARATE ANSWERS: `status` says whether the run finished, `outcome` is the grade (a completed run can be `failed`), and `score` is the number. `pending` counts checks this profile reported but did not score.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.run.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: conformanceRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const run = await client.getConformanceRun(
      { projectId: project.id, runId: input.run },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const listConformanceRunsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  server: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SERVER_SELECTOR_DESCRIPTION),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Rows to return, 1-100. Defaults to the API's own page size."),
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("The `nextCursor` of the previous page, to read the next one."),
});

export type ListConformanceRunsInput = z.infer<typeof listConformanceRunsInput>;

export type ListConformanceRunsResult = {
  project: SelectedProjectInfo;
  runs: PlatformConformanceRun[];
  /** Present while older runs remain. */
  nextCursor?: string;
};

export const listConformanceRunsOperation: PlatformOperation<
  ListConformanceRunsInput,
  ListConformanceRunsResult
> = {
  name: "list_conformance_runs",
  title: "List conformance runs",
  description:
    "List a project's persisted conformance runs, newest first, optionally narrowed to one saved server. Use it to find a run id when you have a server but not a run.",
  readOnly: true,
  permalink: derivePermalinks((result) =>
    result.runs.map((run) => ({
      type: "conformance_run" as const,
      id: run.id,
      projectId: result.project?.id,
    }))
  ),
  inputSchema: listConformanceRunsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const serverId = input.server
      ? (await resolveLiveServer(client, project, input.server, signal)).id
      : undefined;
    const page = await client.listConformanceRuns(
      {
        projectId: project.id,
        ...(serverId ? { serverId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      runs: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

const getConformanceReportInput = conformanceRunScopedInput.extend({
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("The `nextCursor` of the previous page, to read the next one."),
});

export type GetConformanceReportInput = z.infer<
  typeof getConformanceReportInput
>;

export type GetConformanceReportResult = {
  project: SelectedProjectInfo;
} & PlatformConformanceReport;

export const getConformanceReportOperation: PlatformOperation<
  GetConformanceReportInput,
  GetConformanceReportResult
> = {
  name: "get_conformance_report",
  title: "Get a conformance report",
  description:
    "A conformance run's failing checks, up to 50 a page: failed checks first, then could-not-run skips, each with its `suiteKind` and `id` for get_conformance_check. Pass `nextCursor` as `cursor` for the next page; a run still running has only its first page. `pending` on a check means this profile reported it but did not score it.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.runId,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: getConformanceReportInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const report = await client.getConformanceReport(
      {
        projectId: project.id,
        runId: input.run,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), ...report };
  },
};

const getConformanceCheckInput = conformanceRunScopedInput.extend({
  check: z
    .string()
    .trim()
    .min(1)
    .describe("The check's id, as get_conformance_report lists it."),
  suite: z
    .enum(["protocol", "apps", "tasks", "oauth"])
    .optional()
    .describe(
      "The check's suite. Needed only when the same id is in two suites of the run."
    ),
});

export type GetConformanceCheckInput = z.infer<typeof getConformanceCheckInput>;

export type GetConformanceCheckResult = {
  project: SelectedProjectInfo;
} & PlatformConformanceCheck;

export const getConformanceCheckOperation: PlatformOperation<
  GetConformanceCheckInput,
  GetConformanceCheckResult
> = {
  name: "get_conformance_check",
  title: "Get a conformance check",
  description:
    "One check of a persisted conformance run in full: its description, the failure, the duration, and the stored details and output, each capped at 16 KB with a `truncated` flag. Find check ids with get_conformance_report.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.runId,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: getConformanceCheckInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const check = await client.getConformanceCheck(
      {
        projectId: project.id,
        runId: input.run,
        checkId: input.check,
        ...(input.suite ? { suite: input.suite } : {}),
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), ...check };
  },
};
