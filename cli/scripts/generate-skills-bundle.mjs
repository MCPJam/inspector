/**
 * Generates the CLI's SEP-2640 skills bundle.
 *
 * The BUILDER lives in `mcp/scripts/generate-skills-bundle.mjs` and is shared
 * rather than copied. Two implementations of "how a manifest is computed" stay
 * identical exactly until someone edits one of them, and the failure mode is
 * not a broken build — it is one venue advertising digests the other computes
 * differently, which surfaces to a user as a `digest_mismatch` from a server
 * that is in fact serving the right bytes.
 *
 * Sharing costs nothing here: this is a dev-time script, not a runtime import.
 * Neither package ships `scripts/` (`files: ["dist"]`).
 *
 * What differs per venue is the CATALOG, and only the catalog.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSkillsBundle } from "../../mcp/scripts/generate-skills-bundle.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The CLI's catalog: the two skills that teach THIS surface.
 *
 * `mcp-inspector` interprets `mcpjam` probe / doctor / OAuth / conformance
 * output — the tools this stdio server actually exposes. `mcpjam-eval-import`
 * ends in `mcpjam cloud eval validate`, which is a CLI command.
 *
 * The SDK eval-authoring skills are absent: they describe writing
 * `@mcpjam/sdk` tests, which is not what a `mcpjam mcp` client is doing. They
 * are served by the hosted worker instead, next to the eval tools.
 */
export const CLI_SKILL_ROOTS = [
  "skills/mcp-inspector",
  "skills/mcpjam-eval-import",
];

const OUTPUT_TS_PATH = join(
  __dirname,
  "../src/generated/SkillsBundle.generated.ts"
);

export function buildCliSkillsBundle() {
  return buildSkillsBundle(CLI_SKILL_ROOTS);
}

export function generateCliSkillsBundle() {
  const output = buildCliSkillsBundle();
  mkdirSync(dirname(OUTPUT_TS_PATH), { recursive: true });
  writeFileSync(OUTPUT_TS_PATH, output);
  return output;
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  generateCliSkillsBundle();
}
