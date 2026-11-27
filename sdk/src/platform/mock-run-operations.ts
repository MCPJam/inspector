/**
 * The test run operations of a mock server: open a run, reset it, close it.
 * A run pins one version of the mock and gives an external client its own copy
 * of that version's records at a URL of its own, so two runs of the same mock
 * never see each other's writes. Behind the `mock-servers-enabled` flag, which
 * the backend answers.
 */
import { z } from "zod";
import type { PlatformOperation, PlatformOperationContext } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  resolveSavedServer,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { derivePermalinks, noPermalink } from "./permalinks.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type { PlatformMockRun, PlatformMockRunClosed } from "./mock-types.js";

const text = z.string().trim().min(1);
const project = text.optional().describe(PROJECT_SELECTOR_DESCRIPTION);
const mock = text.describe("The mock server's name or ID, as saved in the project.");
const runId = text.describe("The run's ID, as `open_mock_run` returned it.");

const openInput = z.object({
  project,
  mock,
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The version to pin. Defaults to the head. Later saves do not change the run."),
  platformRunId: text
    .optional()
    .describe("The ID of the test or evaluation run this belongs to, when one exists, so the two can be matched."),
});
const resetInput = z.object({
  project,
  mock,
  runId,
  expectedEpoch: z.number().int().min(1).describe("The epoch of the URL you hold. Refused if the run moved on."),
});
const closeInput = z.object({ project, mock, runId });

export type OpenMockRunInput = z.infer<typeof openInput>;
export type ResetMockRunInput = z.infer<typeof resetInput>;
export type CloseMockRunInput = z.infer<typeof closeInput>;
type Scoped<T> = T & { project: SelectedProjectInfo };
export type MockRunResult = Scoped<PlatformMockRun>;
export type CloseMockRunResult = Scoped<PlatformMockRunClosed>;

const permalink = derivePermalinks((result: { mockId: string; project?: { id: string } }) => [
  { type: "project_server" as const, id: result.mockId, projectId: result.project?.id, label: "Open the mock server" },
]);

type Context = Pick<PlatformOperationContext, "client" | "signal" | "onScopeResolved">;

async function resolveMock(context: Context, input: { project?: string; mock: string }) {
  const { project: resolved } = await resolveProjectOrThrow(context, input.project);
  const found = await resolveSavedServer(context.client, resolved, input.mock, context.signal);
  return { project: resolved, mockId: found.id, info: toSelectedProjectInfo(resolved) };
}

export const openMockRunOperation: PlatformOperation<OpenMockRunInput, MockRunResult> = {
  name: "open_mock_run",
  title: "Open a test run of a mock server",
  description:
    "Open a test run of a mock: it pins a version (the head unless you name one) and gives the run its own copy of that version's records, so writes in one run never show in another or in the mock's shared records. Returns runId, version, runUrl (an MCP URL for the run, reached with your own MCPJam API key), epoch and expiresAt. The run lasts 24 hours or until you close it; reconnect to the same URL as often as you need. A live write a forwarded call makes still reaches the real service: a run isolates only the mock's own records.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: openInput,
  async execute(input, context) {
    const { project: resolved, mockId, info } = await resolveMock(context, input);
    const run = await context.client.openMockRun(
      { projectId: resolved.id, mockId, version: input.version, platformRunId: input.platformRunId },
      { signal: context.signal }
    );
    return { ...run, project: info };
  },
};

export const resetMockRunOperation: PlatformOperation<ResetMockRunInput, MockRunResult> = {
  name: "reset_mock_run",
  title: "Reset a test run of a mock server",
  description:
    "Restore a run's records to the version's saved seed. Returns a new runUrl and the next epoch; the old URL is refused from then on, even for a request already on its way, so reconnect to the new one. Name the epoch you hold in expectedEpoch: if the run was reset since, the call is refused with the current epoch. Only the person who opened the run can reset it. A reset changes only the mock's simulated records; a live write that was forwarded stays at the real service.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: resetInput,
  async execute(input, context) {
    const { project: resolved, mockId, info } = await resolveMock(context, input);
    const run = await context.client.resetMockRun(
      { projectId: resolved.id, mockId, runId: input.runId, expectedEpoch: input.expectedEpoch },
      { signal: context.signal }
    );
    return { ...run, project: info };
  },
};

export const closeMockRunOperation: PlatformOperation<CloseMockRunInput, CloseMockRunResult> = {
  name: "close_mock_run",
  title: "Close a test run of a mock server",
  description:
    "End a test run: its URL is refused at once and its records are removed in the next hourly cleanup. Only the person who opened the run can close it. Closing a run that is already closed succeeds. The mock and its saved versions are not changed.",
  readOnly: false,
  risk: "none",
  permalink: noPermalink("mutation-only"),
  inputSchema: closeInput,
  async execute(input, context) {
    const { project: resolved, mockId, info } = await resolveMock(context, input);
    const closed = await context.client.closeMockRun(
      { projectId: resolved.id, mockId, runId: input.runId },
      { signal: context.signal }
    );
    return { ...closed, project: info };
  },
};
