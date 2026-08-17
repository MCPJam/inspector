/**
 * The two generated eval-suite-schema artifacts, built from the zod source.
 *
 * Split out of the CLI so a test can assert the checked-in files byte-match a
 * fresh generation without shelling out to `tsx`. The CLI
 * (`generate-eval-suite-schema.ts`) is a thin wrapper that writes or compares
 * what this returns — one builder, so "what CI checks" and "what the generator
 * writes" cannot drift.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { z } from "zod";
import {
  EVAL_SUITE_SCHEMA_ID,
  EVAL_SUITE_SCHEMA_VERSION,
  evalSuiteFileStructuralSchema,
} from "../src/contract/suite-file.js";

const contractDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/contract"
);

/** The artifact published at the schema's `$id`. */
export const EVAL_SUITE_SCHEMA_JSON_PATH = path.join(
  contractDir,
  "eval-suite.schema.json"
);
/** The TS twin `@mcpjam/sdk/contract` re-exports. */
export const EVAL_SUITE_SCHEMA_TS_PATH = path.join(
  contractDir,
  "eval-suite.schema.generated.ts"
);

export const REGENERATE_COMMAND =
  "npm run generate:eval-suite-schema -w @mcpjam/sdk";

/**
 * The JSON Schema document.
 *
 * Built from the STRUCTURAL schema deliberately: refinements do not project
 * into JSON Schema, so generating from the refined validator would silently
 * publish a schema that is weaker than its own name suggests. The description
 * says which rules are missing rather than leaving a consumer to find out.
 */
export function buildEvalSuiteSchemaDocument(): Record<string, unknown> {
  const generated = z.toJSONSchema(evalSuiteFileStructuralSchema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  // `$schema` first, then identity, then the shape — so a human opening the
  // published file sees what it is before what it contains.
  return {
    $schema,
    $id: EVAL_SUITE_SCHEMA_ID,
    title: `MCPJam eval suite file (schemaVersion ${EVAL_SUITE_SCHEMA_VERSION})`,
    description:
      "Structural contract for an MCPJam eval suite file. Generated from the " +
      "zod source in @mcpjam/sdk (src/contract/suite-file.ts); the zod " +
      "validator is the authoritative superset and additionally enforces " +
      "cross-field rules (unique case ids, unique step ids within a case, and " +
      "a per-case import block requiring top-level provenance) that JSON " +
      "Schema cannot express.",
    ...rest,
  };
}

async function format(source: string, filepath: string): Promise<string> {
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...config, filepath });
}

export type GeneratedArtifact = { path: string; content: string };

/** Both artifacts, formatted exactly as they must appear on disk. */
export async function buildEvalSuiteSchemaArtifacts(): Promise<
  GeneratedArtifact[]
> {
  const document = buildEvalSuiteSchemaDocument();
  return [
    {
      path: EVAL_SUITE_SCHEMA_JSON_PATH,
      content: await format(
        JSON.stringify(document),
        EVAL_SUITE_SCHEMA_JSON_PATH
      ),
    },
    {
      path: EVAL_SUITE_SCHEMA_TS_PATH,
      content: await format(
        `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth: src/contract/suite-file.ts (zod).
// Regenerate with:
//   ${REGENERATE_COMMAND}
//
// The identical document is also written to eval-suite.schema.json, which is
// what the schema's $id publishes. This module exists so package consumers can
// import the schema without a JSON import attribute: the contract subpath is
// built by three toolchains (tsup, Vite with the client's src alias, and plain
// tsc) and only Node-only code in this repo uses import attributes.

/**
 * The eval suite file's JSON Schema (draft 2020-12).
 *
 * STRUCTURAL contract only. Cross-field rules the zod validator enforces —
 * unique case ids, unique step ids within a case, and a per-case \`import\`
 * block requiring top-level \`provenance\` — do not project into JSON Schema.
 * Validate with \`evalSuiteFileSchema\` when you have the SDK; use this when you
 * only have a JSON Schema validator.
 */
export const evalSuiteFileJsonSchema: Record<string, unknown> =
  ${JSON.stringify(document)};
`,
        EVAL_SUITE_SCHEMA_TS_PATH
      ),
    },
  ];
}
