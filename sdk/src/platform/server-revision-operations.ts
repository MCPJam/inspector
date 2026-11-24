/**
 * The server revision operations: list a saved server's stored revisions, read
 * one, and diff two. A revision is a capture of the server's tools and server
 * info, recorded whenever either changes, so these answer "when did this
 * server change, and how" without connecting to it.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import {
  resolveServerScope,
  serverPermalink,
  serverScopedInput,
  type ServerResult,
} from "./operation-support.js";
import { derivePermalinks } from "./permalinks.js";
import type {
  PlatformServerRevision,
  PlatformServerRevisionDiff,
  PlatformServerRevisionSummary,
} from "./server-revision-types.js";

const revisionNumberSchema = z.number().int().min(1);

const listServerRevisionsInput = serverScopedInput.extend({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Revisions per page, newest first. Defaults to 50."),
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("The nextCursor from the previous page, for older revisions."),
});

const getServerRevisionInput = serverScopedInput.extend({
  revisionNumber: revisionNumberSchema.describe(
    "The revision to read, as numbered by list_server_revisions."
  ),
});

const diffServerRevisionsInput = serverScopedInput.extend({
  revisionNumber: revisionNumberSchema.describe(
    "The later revision: the one whose changes you want."
  ),
  fromRevisionNumber: revisionNumberSchema
    .optional()
    .describe(
      "The revision to compare against. Defaults to the one before revisionNumber."
    ),
});

export type ListServerRevisionsInput = z.infer<typeof listServerRevisionsInput>;
export type GetServerRevisionInput = z.infer<typeof getServerRevisionInput>;
export type DiffServerRevisionsInput = z.infer<typeof diffServerRevisionsInput>;

export type ListServerRevisionsResult = ServerResult & {
  items: PlatformServerRevisionSummary[];
  nextCursor?: string;
};
export type GetServerRevisionResult = ServerResult & {
  revision: PlatformServerRevision;
};
export type DiffServerRevisionsResult = ServerResult & {
  diff: PlatformServerRevisionDiff;
};

export const listServerRevisionsOperation: PlatformOperation<
  ListServerRevisionsInput,
  ListServerRevisionsResult
> = {
  name: "list_server_revisions",
  title: "List a server's revisions",
  description:
    "List the stored revisions of a saved MCP server, newest first. A revision is a capture of the server's tools and server info, recorded whenever they change on a connect, an eval run or a chat session. Use it to find when a server changed, then diff_server_revisions to see what changed. Paginated: pass nextCursor back as cursor for older revisions.",
  readOnly: true,
  permalink: derivePermalinks(serverPermalink),
  inputSchema: listServerRevisionsInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const page = await client.listServerRevisions(
      { ...scope, limit: input.limit, cursor: input.cursor },
      { signal: context.signal }
    );
    return { ...result, ...page };
  },
};

export const getServerRevisionOperation: PlatformOperation<
  GetServerRevisionInput,
  GetServerRevisionResult
> = {
  name: "get_server_revision",
  title: "Get a server revision",
  description:
    "Read one stored revision of a saved MCP server: every tool's definition (description, input and output schemas, annotations, meta) and the server info it reported (name, version, capabilities, instructions). droppedFields lists values storage dropped for size; treat those as unknown, not absent.",
  readOnly: true,
  permalink: derivePermalinks(serverPermalink),
  inputSchema: getServerRevisionInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const revision = await client.getServerRevision(
      { ...scope, revisionNumber: input.revisionNumber },
      { signal: context.signal }
    );
    return { ...result, revision };
  },
};

export const diffServerRevisionsOperation: PlatformOperation<
  DiffServerRevisionsInput,
  DiffServerRevisionsResult
> = {
  name: "diff_server_revisions",
  title: "Diff two server revisions",
  description:
    "Compare two stored revisions of a saved MCP server: tools added and removed with their definitions, tools changed with the fields that moved and their old and new definitions, and server info fields such as serverInfo.version or instructions with old and new values. Compares with the previous revision unless fromRevisionNumber is given. A field listed in droppedFields was not stored on that side, so a change to it is not established.",
  readOnly: true,
  permalink: derivePermalinks(serverPermalink),
  inputSchema: diffServerRevisionsInput,
  async execute(input, context) {
    const { client, scope, result } = await resolveServerScope(input, context);
    const diff = await client.diffServerRevisions(
      {
        ...scope,
        revisionNumber: input.revisionNumber,
        fromRevisionNumber: input.fromRevisionNumber,
      },
      { signal: context.signal }
    );
    return { ...result, diff };
  },
};
