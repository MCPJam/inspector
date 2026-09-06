/**
 * Generate the published JSON Schema for the eval suite file.
 *
 *   npm run generate:eval-suite-schema -w @mcpjam/sdk
 *   npm run check:eval-suite-schema   -w @mcpjam/sdk   # staleness guard
 *
 * TWO artifacts, from ONE source (`src/contract/suite-file.ts`):
 *
 *   - `src/contract/eval-suite.schema.json` — the artifact published at the
 *     schema's `$id`, for editors and third-party validators that fetch a URL.
 *   - `src/contract/eval-suite.schema.generated.ts` — the identical object as a
 *     TS module, which is what `@mcpjam/sdk/contract` re-exports.
 *
 * Both are built by `./eval-suite-schema-artifacts.ts`, which
 * `tests/eval-suite-schema-json.test.ts` also calls — so the vitest guard and
 * this CLI can never disagree about what "up to date" means.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REGENERATE_COMMAND,
  buildEvalSuiteSchemaArtifacts,
} from "./eval-suite-schema-artifacts.js";

const CHECK_ONLY = process.argv.includes("--check");

const artifacts = await buildEvalSuiteSchemaArtifacts();

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
      `Eval suite JSON Schema artifacts are stale: ${stale.join(", ")}. ` +
        `Run \`${REGENERATE_COMMAND}\`. Never hand-edit them — the zod schema ` +
        `in src/contract/suite-file.ts is the source.`
    );
  }
} else {
  for (const artifact of artifacts) {
    writeFileSync(artifact.path, artifact.content);
  }
}
