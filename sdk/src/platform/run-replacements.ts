/**
 * `run_eval_suite`'s `serverReplacements`: run the suite with one server of
 * its environment replaced, by name, by another saved server (a mock).
 * The wire body carries ids; the operation takes the names a person reads.
 */
import { z } from "zod";
import type { PlatformApiClient } from "./client.js";
import { resolveSavedServer } from "./operation-support.js";
import type { PlatformProject } from "./types.js";

export const serverReplacementsInput = z
  .array(
    z.object({
      server: z
        .string()
        .trim()
        .min(1)
        .describe("The environment's server to replace, by the name `list_project_servers` shows."),
      replacement: z
        .string()
        .trim()
        .min(1)
        .describe("The saved server that stands in for it, by name or ID: usually a mock of that server."),
      version: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("The mock version to open. The run records it. Omit for the head."),
      realListingHash: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Hash of the real server's tool listing. MCPJam reads the listing and fills it in when omitted."),
    })
  )
  .min(1)
  .max(5)
  .optional()
  .describe(
    "Run each environment with these servers replaced, by name. The run keeps the real server's name, so a step pinned to it reaches the replacement. Environment suites only."
  );

type Replacements = z.infer<typeof serverReplacementsInput>;

/** The launch body's `serverReplacements`, with each replacement resolved to its ID. */
export async function replacementsBody(
  client: PlatformApiClient,
  project: PlatformProject,
  replacements: Replacements,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  if (!replacements) return {};
  const serverReplacements = [];
  for (const entry of replacements) {
    const saved = await resolveSavedServer(client, project, entry.replacement, signal);
    serverReplacements.push({
      serverName: entry.server,
      replacementServerId: saved.id,
      ...(entry.version ? { replacementVersion: entry.version } : {}),
      ...(entry.realListingHash ? { realListingHash: entry.realListingHash } : {}),
    });
  }
  return { serverReplacements };
}
