/**
 * The mock server operations: create a mock of a saved server (or of nothing),
 * save a new version of it, and read one version with its address and the real
 * server's current values.
 *
 * The Inspector's route validates the definition, refuses an input change that
 * leaves a real tool uncallable, and builds the change list, because that code
 * is Node-only. These operations take the definition as JSON and pass it on.
 * Creating and saving are behind the `climbs` feature (the backend answers
 * `FEATURE_UNAVAILABLE` when it is off); reading is not, so a mock that exists
 * stays readable.
 */
import { z } from "zod";
import type { PlatformOperation, PlatformOperationContext } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  resolveSavedServer,
  toSelectedProjectInfo,
} from "./operation-support.js";
import { derivePermalinks } from "./permalinks.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type { PlatformMockSaved, PlatformMockServer } from "./mock-types.js";

const text = z.string().trim().min(1);
const positive = z.number().int().min(1);
const project = text.optional().describe(PROJECT_SELECTOR_DESCRIPTION);
const mock = text.describe("The mock server's name or ID, as saved in the project.");
const json = z.record(z.string(), z.unknown());

const definition = json.describe(
  'The mock\'s definition. It states only what it changes; the real server answers for the rest. { serverInfo?, instructions?, capabilities?, tools?: { "<name a client sees>": { hidden?, title?, description?, inputSchema?, outputSchema?, annotations?, icons?, _meta?, params?: { "<parameter>": { hidden? | fixed? | description? } }, answer?: { tool?, arguments? } } } }. A rename is two entries: { "find": { "answer": { "tool": "search" } }, "search": { "hidden": true } }.'
);

const createInput = z.object({
  project,
  server: text
    .optional()
    .describe("The saved server (name or ID) to sit in front of. Omit for a mock from nothing."),
  name: text.describe("The mock's name, unique among the workspace's servers."),
  definition,
});

const updateInput = z
  .object({
    project,
    mock,
    definition: definition.optional().describe("The whole next definition. Give this or `patch`."),
    patch: json
      .optional()
      .describe("An RFC 7396 JSON merge patch over the head: null removes a key, objects merge."),
    expectedVersion: positive.describe(
      "The head version you read. Refused with the head if stale."
    ),
    dryRun: z.boolean().optional().describe("Return the change list without saving."),
  })
  .refine((input) => (input.definition === undefined) !== (input.patch === undefined), {
    message: "Give exactly one of `definition` and `patch`.",
  });

const getInput = z.object({
  project,
  mock,
  version: positive.optional().describe("The version to read. Defaults to the head."),
  sinceVersion: positive.optional().describe("Also list what changed from this version."),
});

export type CreateMockServerInput = z.infer<typeof createInput>;
export type UpdateMockServerInput = z.infer<typeof updateInput>;
export type GetMockServerInput = z.infer<typeof getInput>;
type Scoped<T> = T & { project: SelectedProjectInfo };
export type CreateMockServerResult = Scoped<PlatformMockSaved>;
export type UpdateMockServerResult = Scoped<PlatformMockSaved>;
export type GetMockServerResult = Scoped<PlatformMockServer>;

const permalink = derivePermalinks(
  (result: { id: string; name: string; project?: { id: string } }) => [
    {
      type: "project_server" as const,
      id: result.id,
      projectId: result.project?.id,
      label: `Open ${result.name}`,
    },
  ]
);

type Context = Pick<PlatformOperationContext, "client" | "signal" | "onScopeResolved">;

/** The project and the mock a selector names. */
async function resolveMock(context: Context, input: { project?: string; mock: string }) {
  const { project } = await resolveProjectOrThrow(context, input.project);
  const { client, signal } = context;
  const mock = await resolveSavedServer(client, project, input.mock, signal);
  return { project, mockId: mock.id, info: toSelectedProjectInfo(project) };
}

export const createMockServerOperation: PlatformOperation<
  CreateMockServerInput,
  CreateMockServerResult
> = {
  name: "create_mock_server",
  title: "Create a mock server",
  description:
    "Create a mock of a saved MCP server, or of nothing, with a definition that changes only what you state: a tool's description or schema, its annotations, hidden or fixed parameters, or a renamed tool. The real server answers for everything else, with the caller's own credentials and is not changed. Returns the mock's id, its address (an MCP URL any client reaches with an MCPJam API key), version 1 and the change list. The definition is checked first; a change that leaves a real tool uncallable is refused with the parameter named.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: createInput,
  async execute(input, context) {
    const { client, signal } = context;
    const { project } = await resolveProjectOrThrow(context, input.project);
    const base =
      input.server === undefined
        ? undefined
        : await resolveSavedServer(client, project, input.server, signal);
    const { name, definition } = input;
    const projectId = project.id;
    const saved = await client.createMockServer(
      { projectId, name, serverId: base?.id, definition },
      { signal }
    );
    return { ...saved, project: toSelectedProjectInfo(project) };
  },
};

export const updateMockServerOperation: PlatformOperation<
  UpdateMockServerInput,
  UpdateMockServerResult
> = {
  name: "update_mock_server",
  title: "Update a mock server",
  description:
    "Save a new version of a mock server from a whole definition or a JSON merge patch, naming the head version you read in expectedVersion. If another version landed since, the save is refused and names the current head: read the mock again and retry. Saving a definition equal to the head writes nothing. With dryRun the change is validated and its change list returned without saving. A save that loosens a tool's safety annotations needs the manage tier.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: updateInput,
  async execute(input, context) {
    const { project, mockId, info } = await resolveMock(context, input);
    const { definition, patch, expectedVersion, dryRun } = input;
    const saved = await context.client.saveMockServerVersion(
      { projectId: project.id, mockId, definition, patch, expectedVersion, dryRun },
      { signal: context.signal }
    );
    return { ...saved, project: info };
  },
};

export const getMockServerOperation: PlatformOperation<GetMockServerInput, GetMockServerResult> = {
  name: "get_mock_server",
  title: "Get a mock server",
  description:
    "Read one version of a mock server (the head by default): its address, its definition, and the real server's current values for what the definition edits, so a change can be written without reading the real server separately. With sinceVersion, also the change list from that version. realServer.status says whether the real server could be read.",
  readOnly: true,
  permalink,
  inputSchema: getInput,
  async execute(input, context) {
    const { project, mockId, info } = await resolveMock(context, input);
    const { version, sinceVersion } = input;
    const read = await context.client.getMockServer(
      { projectId: project.id, mockId, version, sinceVersion },
      { signal: context.signal }
    );
    return { ...read, project: info };
  },
};
