/**
 * The pinned adapter's version, as the availability gate wants it.
 *
 * Shared by both runners because they were maintaining the same block twice,
 * and the resolution rule in it is the fiddly part: the adapter is a workspace
 * dependency, so npm hoists it to the REPO root rather than under
 * `mcpjam-inspector/node_modules`. A path relative to this file is correct on
 * exactly one of those layouts and silently wrong on the other — which is the
 * failure `check:bundled-runtime-paths` exists to catch, and which broke every
 * conformance leg once already.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export async function installedAdapterVersion(): Promise<string> {
  const manifest = createRequire(import.meta.url).resolve(
    "@ai-sdk/harness-claude-code/package.json",
  );
  return JSON.parse(await readFile(manifest, "utf8")).version;
}
