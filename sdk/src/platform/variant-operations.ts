/**
 * Server variants, in beta behind the `variant-servers-enabled` flag. A
 * variant is a saved server's live tool list with edited tool descriptions,
 * stored under a server id of its own. It changes nothing on the base, and a
 * run or chat that names its id is served the base's live catalog with the
 * edits applied.
 */
import { z } from "zod";
import { VARIANT_LIMITS } from "../variants/draft.js";
import { variantErrorMessages } from "../variants/errors.js";
import type { VariantDefinition, VariantDiffEntry } from "../variants/types.js";
import type { PlatformOperation } from "./operations.js";
import {
  PROJECT_SELECTOR_DESCRIPTION,
  resolveProjectOrThrow,
  resolveSavedServer,
  serverPermalink,
  toSelectedProjectInfo,
  toServerInfo,
  type ServerResult,
} from "./operation-support.js";
import { derivePermalinks } from "./permalinks.js";

const editInput = z.object({
  feature: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What the edit changes. This release supports "tools.description".'
    ),
  target: z
    .string()
    .min(1)
    .describe("The tool's name exactly as the base lists it."),
  op: z.string().trim().min(1).describe('How the edit applies: "set".'),
  value: z.string().describe("The new description, 1 to 10,000 characters."),
});

/** The body of `POST /projects/{projectId}/variant-servers`; `server` is an id or a name. */
export type PlatformVariantServerBody = {
  server: string;
  edits: z.infer<typeof editInput>[];
  label?: string;
};

/** A stored variant, and how its descriptions differ from the base's. */
export type PlatformVariantServer = {
  variant: VariantDefinition & { label?: string; created: boolean };
  diff: VariantDiffEntry[];
};

const createVariantServerInput = z.object({
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
    .describe(
      "The base: a saved HTTP server's name or ID. A variant can't be the base of another variant."
    ),
  edits: z
    .array(editInput)
    .min(1, "A variant needs at least one edit.")
    .max(VARIANT_LIMITS.maxEdits, variantErrorMessages.VARIANT_TOO_LARGE())
    .describe(
      `The edits, in order, at most one per tool: 1 to ${VARIANT_LIMITS.maxEdits}, and at most 256 KB in all.`
    ),
  label: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("A name for this variant, such as the change it tests."),
});

export type CreateVariantServerInput = z.infer<typeof createVariantServerInput>;
export type CreateVariantServerResult = ServerResult & PlatformVariantServer;

export const createVariantServerOperation: PlatformOperation<
  CreateVariantServerInput,
  CreateVariantServerResult
> = {
  name: "create_variant_server",
  title: "Create a server variant",
  description:
    "Create a variant of a saved HTTP server: the base's live tool list with edited tool descriptions, stored under a server ID of its own. Nothing on the base changes. A connection to the variant passes every request through to the base with the caller's own credentials for it, and only the listed descriptions differ. Use `variant.serverId` like any server ID, for example in ensure_adhoc_environment's servers, to run an eval suite on the variant beside the base. The same base, base tool list and edits return the existing variant with `created: false`. If the base later changes a tool the variant edits, runs on the variant are refused with VARIANT_BASE_DRIFTED, and the variant has to be created again. In beta: an organization outside the beta is refused, and the error names the feature.",
  readOnly: false,
  // A new server row: the base is untouched, and nothing is spent.
  risk: "none",
  permalink: derivePermalinks(serverPermalink),
  inputSchema: createVariantServerInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const context = { client, signal, onScopeResolved };
    const { project } = await resolveProjectOrThrow(context, input.project);
    const server = await resolveSavedServer(
      client,
      project,
      input.server,
      signal
    );
    const body = {
      server: server.id,
      edits: input.edits,
      ...(input.label ? { label: input.label } : {}),
    };
    const created = await client.createVariantServer(
      { projectId: project.id, body },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      ...created,
    };
  },
};
