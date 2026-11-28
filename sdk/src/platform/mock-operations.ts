/**
 * The mock server operations: create a mock of a saved server (or of nothing),
 * read one, save its next version, and read or set the policy that decides
 * whether mocks may call their real servers.
 *
 * The Inspector's route validates the definition, refuses an input change that
 * leaves a real tool uncallable, and reads the real server, because that code
 * is Node-only. These operations take the definition as JSON and pass it on.
 * Every one is behind the `mock-servers-enabled` flag, which the backend
 * answers; it refuses with a message that names the flag when it is off.
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
import type {
  PlatformMockForwardingPolicy,
  PlatformMockPatched,
  PlatformMockRead,
  PlatformMockRefresh,
  PlatformMockWritten,
} from "./mock-types.js";

const text = z.string().trim().min(1);
const positive = z.number().int().min(1);
const project = text.optional().describe(PROJECT_SELECTOR_DESCRIPTION);
const mock = text.describe("The mock server's name or ID, as saved in the project.");
const json = z.record(z.string(), z.unknown());

const definition = json.describe(
  'The mock\'s definition. It states only what it changes; the real server answers for the rest. { serverInfo?, instructions?, capabilities?, tools?: { "<name a client sees>": { hidden?, title?, description?, inputSchema?, outputSchema?, annotations?, icons?, _meta?, params?: { "<parameter>": { hidden? | fixed? | description? } }, answer?: { tool?, arguments? } | { from: "saved", cases: [{ when?, result | error }] } } } }. A rename is two entries: { "find": { "answer": { "tool": "search" } }, "search": { "hidden": true } }.'
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
    expectedVersion: positive.describe("The head version you read. Refused with the head if stale."),
  })
  .refine((input) => (input.definition === undefined) !== (input.patch === undefined), {
    message: "Give exactly one of `definition` and `patch`.",
  });

const family = z
  .enum(["tools", "prompts", "resources", "resourceTemplates"])
  .describe("The kind of entry: tools, prompts, resources (by URI) or resourceTemplates (by URI template).");
const pathInput = z
  .union([text, z.array(text).min(1)])
  .describe(
    'A path inside the entry (or inside the definition without a family): dotted like "inputSchema.properties.query.description", or a list of keys when a key contains a dot.'
  );

const getInput = z.object({
  project,
  mock,
  version: positive.optional().describe("The version to read. Defaults to the head. A cursor stays on the version its first page read."),
  family: family.optional().describe("List this kind of entry (a page of names), or name one with `name`."),
  name: text.optional().describe("Read exactly this entry (with `family`)."),
  path: pathInput.optional().describe("Read one field or nested path. A long string comes in ordered chunks: join `value` across pages until page.end."),
  search: text.optional().describe("List only names containing this text (with `family`)."),
  limit: z.number().int().min(1).max(200).optional().describe("Most names per page; fewer come back when the page would not fit."),
  cursor: text.optional().describe("`page.nextCursor` from the previous page of the same read, as the same caller."),
});

const patchInput = z.object({
  project,
  mock,
  expectedVersion: positive.describe("The head version you read. Refused with the head if stale."),
  family: family.optional().describe("With `name`: the entry's kind. Leave both out to patch a server-wide setting such as instructions."),
  name: text.optional().describe("The entry to change, exactly as a client sees it."),
  path: z
    .array(text)
    .optional()
    .describe('Keys inside the entry, e.g. ["description"] or ["params", "limit", "fixed"]. Empty with a name sets the whole entry.'),
  value: z.unknown().optional().describe("The new value for the path."),
  remove: z.boolean().optional().describe("Remove the path instead, so the real server's own value shows again."),
});

const refreshInput = z.object({
  project,
  mock,
  expectedVersion: positive.describe("The head version you read."),
  apply: z.boolean().optional().describe("Save the refreshed listing as the next version. Without it, only previews."),
});

const policyReadInput = z.object({
  project,
  mock: mock.optional().describe("Read the policy in force for this mock. Omit for the project's workspace."),
});

const policySetInput = z.object({
  project,
  forwarding: z
    .enum(["allow", "block"])
    .describe(
      "`block` stops every mock in the workspace calling its real server (saved answers still serve); `allow` lets them. Workspace admins only."
    ),
});

export type CreateMockServerInput = z.infer<typeof createInput>;
export type UpdateMockServerInput = z.infer<typeof updateInput>;
export type GetMockServerInput = z.infer<typeof getInput>;
export type PatchMockServerInput = z.infer<typeof patchInput>;
export type RefreshMockServerInput = z.infer<typeof refreshInput>;
export type GetMockForwardingPolicyInput = z.infer<typeof policyReadInput>;
export type SetMockForwardingPolicyInput = z.infer<typeof policySetInput>;
type Scoped<T> = T & { project: SelectedProjectInfo };
export type CreateMockServerResult = Scoped<PlatformMockWritten>;
export type UpdateMockServerResult = Scoped<PlatformMockWritten>;
export type GetMockServerResult = Scoped<PlatformMockRead>;
export type PatchMockServerResult = Scoped<PlatformMockPatched>;
export type RefreshMockServerResult = Scoped<PlatformMockRefresh>;
export type MockForwardingPolicyResult = Scoped<PlatformMockForwardingPolicy>;

const permalink = derivePermalinks(
  (result: { id: string; name?: string; mockName?: string; project?: { id: string } }) => [
    {
      type: "project_server" as const,
      id: result.id,
      projectId: result.project?.id,
      label: `Open ${result.mockName ?? result.name ?? "mock server"}`,
    },
  ]
);

type Context = Pick<PlatformOperationContext, "client" | "signal" | "onScopeResolved">;

/** The project and the mock a selector names. */
async function resolveMock(context: Context, input: { project?: string; mock: string }) {
  const { project } = await resolveProjectOrThrow(context, input.project);
  const found = await resolveSavedServer(context.client, project, input.mock, context.signal);
  return { project, mockId: found.id, info: toSelectedProjectInfo(project) };
}

export const createMockServerOperation: PlatformOperation<CreateMockServerInput, CreateMockServerResult> = {
  name: "create_mock_server",
  title: "Create a mock server",
  description:
    "Create a mock of a saved MCP server, or of nothing, with a definition that changes only what you state: a tool's description or schema, its annotations, hidden or fixed parameters, a renamed tool, or a saved answer. The real server answers for everything else, with the caller's own credentials, and is not changed. Returns the mock's id, its address (an MCP URL any client reaches with an MCPJam API key), version 1 and any safety annotation it loosened. The definition is checked first; a change that leaves a real tool uncallable is refused with the parameter named. Repeating the same create returns the same mock.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: createInput,
  async execute(input, context) {
    const { client, signal } = context;
    const { project } = await resolveProjectOrThrow(context, input.project);
    const base =
      input.server === undefined ? undefined : await resolveSavedServer(client, project, input.server, signal);
    const saved = await client.createMockServer(
      { projectId: project.id, name: input.name, serverId: base?.id, definition: input.definition },
      { signal }
    );
    return { ...saved, project: toSelectedProjectInfo(project) };
  },
};

export const updateMockServerOperation: PlatformOperation<UpdateMockServerInput, UpdateMockServerResult> = {
  name: "update_mock_server",
  title: "Update a mock server",
  description:
    "Save a new version of a mock server from a whole definition or a JSON merge patch, naming the head version you read in expectedVersion. If another version landed since, the save is refused and names the current head: read the mock again and retry. Saving a definition equal to the head writes nothing and returns the head (a retry of a save that landed is safe). A save that makes a tool's safety annotations look safer than the real tool's needs the manage tier.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: updateInput,
  async execute(input, context) {
    const { project, mockId, info } = await resolveMock(context, input);
    const { definition: whole, patch, expectedVersion } = input;
    const saved = await context.client.saveMockServerVersion(
      { projectId: project.id, mockId, definition: whole, patch, expectedVersion },
      { signal: context.signal }
    );
    return { ...saved, project: info };
  },
};

export const getMockServerOperation: PlatformOperation<GetMockServerInput, GetMockServerResult> = {
  name: "get_mock_server",
  title: "Get a mock server",
  description:
    "Read a mock server in bounded pages, so a mock with hundreds of tools or a very long description fits any response. With no selector: id, address, version, base server, the forwarding policy in force, counts, and a page of its changes (a change is a tool, prompt, resource or template it adds, edits or hides, or a server-wide setting). With `family`: a page of that kind's names (the real server's saved listing with the mock's edits), narrowed by `search`. With `family` and `name`: that entry, what the mock states and what a client sees. With `path` too: one field or nested path; a long string comes in ordered chunks, so join `value` across pages. Continue any page with `page.nextCursor`; a cursor stays on the version it started on, is bound to your account and to the read, and the last page says `end: true`. headVersion is the version to name in update_mock_server's and patch_mock_server's expectedVersion.",
  readOnly: true,
  permalink,
  inputSchema: getInput,
  async execute(input, context) {
    const { project, mockId, info } = await resolveMock(context, input);
    const { project: _project, mock: _mock, ...selector } = input;
    const read = await context.client.getMockServer(
      { projectId: project.id, mockId, ...selector },
      { signal: context.signal }
    );
    return { ...read, project: info };
  },
};

export const patchMockServerOperation: PlatformOperation<PatchMockServerInput, PatchMockServerResult> = {
  name: "patch_mock_server",
  title: "Patch one path of a mock server",
  description:
    'Set or remove exactly one path of a mock (an entry, a field or a nested path) and save it as the next version, naming the head version you read in expectedVersion. You send only the path and the value, never the entry: to change a late tool\'s description, give family "tools", its name, path ["description"] and the new value. Refused with the head if another version landed since; read again and retry. Repeating a patch that already landed returns the head. The whole definition is checked first, and a path that makes it invalid is refused with that path named.',
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: patchInput,
  async execute(input, context) {
    const { project, mockId, info } = await resolveMock(context, input);
    const { project: _project, mock: _mock, ...edit } = input;
    const patched = await context.client.patchMockServer(
      { projectId: project.id, mockId, ...edit },
      { signal: context.signal }
    );
    return { ...patched, project: info };
  },
};

export const refreshMockServerOperation: PlatformOperation<RefreshMockServerInput, RefreshMockServerResult> = {
  name: "refresh_mock_server",
  title: "Refresh a mock server from its real server",
  description:
    "Read the mock's real server again, as you, and compare it with the listing the head version saved: which tools, prompts, resources and templates were added, removed or changed, and which of the mock's overrides no longer fit (named by path, for you to repair; nothing is renamed on its own). It saves nothing unless `apply` is set, which saves the new listing as the next version against expectedVersion. Needs a mock made from a saved server.",
  readOnly: false,
  risk: "none",
  permalink,
  inputSchema: refreshInput,
  async execute(input, context) {
    const { project, mockId, info } = await resolveMock(context, input);
    const refreshed = await context.client.refreshMockServer(
      { projectId: project.id, mockId, expectedVersion: input.expectedVersion, apply: input.apply },
      { signal: context.signal }
    );
    return { ...refreshed, project: info };
  },
};

export const getMockForwardingPolicyOperation: PlatformOperation<
  GetMockForwardingPolicyInput,
  MockForwardingPolicyResult
> = {
  name: "get_mock_forwarding_policy",
  title: "Get the mock forwarding policy",
  description:
    "Read whether mock servers may call their real servers: for one mock (the policy in force for it) or, without `mock`, for the project's workspace. `block` means a call a mock would forward is refused without reaching the real server, and saved answers still serve. scope says whether the workspace's own setting or the organization's applies.",
  readOnly: true,
  permalink: noPermalink("no-addressable-resource", "The policy is a setting, not a page."),
  inputSchema: policyReadInput,
  async execute(input, context) {
    const { project } = await resolveProjectOrThrow(context, input.project);
    const mockId = input.mock
      ? (await resolveSavedServer(context.client, project, input.mock, context.signal)).id
      : undefined;
    const policy = await context.client.getMockForwardingPolicy(
      { projectId: project.id, mockId },
      { signal: context.signal }
    );
    return { ...policy, project: toSelectedProjectInfo(project) };
  },
};

export const setMockForwardingPolicyOperation: PlatformOperation<
  SetMockForwardingPolicyInput,
  MockForwardingPolicyResult
> = {
  name: "set_mock_forwarding_policy",
  title: "Set the mock forwarding policy",
  description:
    "Allow or block mock servers calling their real servers, for the project's whole workspace. Workspace admins only; anyone else is refused. Takes effect on the next call, including for runs already started. It does not change what any mock saves.",
  readOnly: false,
  risk: "exposure",
  permalink: noPermalink("mutation-only"),
  inputSchema: policySetInput,
  async execute(input, context) {
    const { project } = await resolveProjectOrThrow(context, input.project);
    const policy = await context.client.setMockForwardingPolicy(
      { projectId: project.id, forwarding: input.forwarding },
      { signal: context.signal }
    );
    return { ...policy, project: toSelectedProjectInfo(project) };
  },
};
