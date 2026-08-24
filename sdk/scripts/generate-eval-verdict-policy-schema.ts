/**
 * Generate the published JSON Schema for the eval run verdict decision.
 *
 *   npm run generate:eval-verdict-policy-schema -w @mcpjam/sdk
 *   npm run check:eval-verdict-policy-schema   -w @mcpjam/sdk   # staleness guard
 *
 * TWO artifacts, from ONE source (`src/contract/verdict-policy.ts`):
 *
 *   - `src/contract/eval-verdict-policy.schema.json` — the artifact published at
 *     the schema's `$id`, for third-party validators that fetch a URL.
 *   - `src/contract/eval-verdict-policy.schema.generated.ts` — the identical
 *     object as a TS module, which is what `@mcpjam/sdk/contract` re-exports.
 *
 * Both are built by `./eval-verdict-policy-schema-artifacts.ts`, which
 * `tests/eval-verdict-policy-schema-json.test.ts` also calls — so the vitest
 * guard and this CLI can never disagree about what "up to date" means.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REGENERATE_COMMAND,
  buildEvalVerdictPolicySchemaArtifacts,
} from "./eval-verdict-policy-schema-artifacts.js";

const CHECK_ONLY = process.argv.includes("--check");

const artifacts = await buildEvalVerdictPolicySchemaArtifacts();

if (CHECK_ONLY) {
  const stale: string[] = [];
  for (const artifact of artifacts) {
    let current: string;
    try {
      current = readFileSync(artifact.path, "utf8");
    } catch {
      stale.push(`${path.basename(artifact.path)} (missing)`);
      continue;
    }
    if (current !== artifact.content) {
      stale.push(path.basename(artifact.path));
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Eval verdict policy JSON Schema artifacts are stale: ${stale.join(
        ", "
      )}. ` +
        `Run \`${REGENERATE_COMMAND}\`. Never hand-edit them — the zod schema ` +
        `in src/contract/verdict-policy.ts is the source.`
    );
  }
} else {
  for (const artifact of artifacts) {
    writeFileSync(artifact.path, artifact.content);
  }
}
