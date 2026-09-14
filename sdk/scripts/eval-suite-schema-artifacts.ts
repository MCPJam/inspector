/**
 * The generated eval-suite-schema artifacts, built from the zod source — a
 * `.json` + `.ts` pair per dialect.
 *
 * Split out of the CLI so a test can assert the checked-in files byte-match a
 * fresh generation without shelling out to `tsx`. The CLI
 * (`generate-eval-suite-schema.ts`) is a thin wrapper that writes or compares
 * what this returns — one builder, so "what CI checks" and "what the generator
 * writes" cannot drift.
 *
 * One document per dialect, never a `oneOf` over both: dialect 1's document is
 * published at its own `$id` and is frozen, so an older strict reader keeps
 * validating exactly what it always did. Dialect 2 gets its own `$id`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { z } from "zod";
import {
  EVAL_SUITE_SCHEMA_ID,
  EVAL_SUITE_SCHEMA_ID_V2,
  EVAL_SUITE_SCHEMA_VERSION,
  EVAL_SUITE_SCHEMA_VERSION_2,
  evalSuiteFileStructuralSchema,
  evalSuiteFileV2StructuralSchema,
  type EvalSuiteSchemaVersion,
} from "../src/contract/suite-file.js";
import { MAX_INTENT_CHARS } from "../src/contract/stage-intent.js";

const contractDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/contract"
);

/** The dialect-1 artifact published at the schema's `$id`. */
export const EVAL_SUITE_SCHEMA_JSON_PATH = path.join(
  contractDir,
  "eval-suite.schema.json"
);
/** The dialect-1 TS twin `@mcpjam/sdk/contract` re-exports. */
export const EVAL_SUITE_SCHEMA_TS_PATH = path.join(
  contractDir,
  "eval-suite.schema.generated.ts"
);
/** The dialect-2 artifact published at its `$id`. */
export const EVAL_SUITE_SCHEMA_V2_JSON_PATH = path.join(
  contractDir,
  "eval-suite.v2.schema.json"
);
/** The dialect-2 TS twin `@mcpjam/sdk/contract` re-exports. */
export const EVAL_SUITE_SCHEMA_V2_TS_PATH = path.join(
  contractDir,
  "eval-suite.v2.schema.generated.ts"
);

/** Everything that differs between the two dialects' documents. */
type DialectArtifact = {
  version: EvalSuiteSchemaVersion;
  id: string;
  structural: z.ZodTypeAny;
  jsonPath: string;
  tsPath: string;
  /** The `.ts` twin's exported const. */
  exportName: string;
  /** The zod validator a reader with the SDK should use instead. */
  validatorName: string;
};

const DIALECTS: readonly DialectArtifact[] = [
  {
    version: EVAL_SUITE_SCHEMA_VERSION,
    id: EVAL_SUITE_SCHEMA_ID,
    structural: evalSuiteFileStructuralSchema,
    jsonPath: EVAL_SUITE_SCHEMA_JSON_PATH,
    tsPath: EVAL_SUITE_SCHEMA_TS_PATH,
    exportName: "evalSuiteFileJsonSchema",
    validatorName: "evalSuiteFileSchema",
  },
  {
    version: EVAL_SUITE_SCHEMA_VERSION_2,
    id: EVAL_SUITE_SCHEMA_ID_V2,
    structural: evalSuiteFileV2StructuralSchema,
    jsonPath: EVAL_SUITE_SCHEMA_V2_JSON_PATH,
    tsPath: EVAL_SUITE_SCHEMA_V2_TS_PATH,
    exportName: "evalSuiteFileV2JsonSchema",
    validatorName: "evalSuiteFileSchema",
  },
];

export const REGENERATE_COMMAND =
  "npm run generate:eval-suite-schema -w @mcpjam/sdk";

/**
 * True for the element-locator object node.
 *
 * Identified by shape rather than by reference because the locator reaches the
 * override hook as the object INSIDE its `.refine()` wrapper, which is not the
 * exported schema object. `eval-suite-schema-json.test.ts` walks the finished
 * document and asserts every locator-shaped node carries the constraint, so a
 * detector that silently stopped matching fails the build rather than quietly
 * publishing an unconstrained locator.
 */
function isElementLocatorNode(node: Record<string, unknown>): boolean {
  const properties = node.properties as Record<string, unknown> | undefined;
  if (!properties) return false;
  return (
    "role" in properties &&
    "text" in properties &&
    "css" in properties &&
    "testId" in properties &&
    "nth" in properties
  );
}

/** The locator's "at least one reference point" rule, in JSON Schema terms. */
export const ELEMENT_LOCATOR_ANY_OF = [
  { required: ["role"] },
  { required: ["text"] },
  { required: ["css"] },
  { required: ["testId"] },
];

/**
 * The authored intent validator accepts only an already-trimmed label. Zod
 * refinements do not project into JSON Schema, but this one is expressible as
 * a boundary pattern and matters to third-party validators: accepting a
 * padded label here would produce a suite file the SDK rejects at load time.
 * `\\S` guards both ends while `[\\s\\S]` keeps internal whitespace,
 * including newlines, legal just as `String.prototype.trim()` does.
 */
const INTENT_TRIMMED_PATTERN = "^\\S(?:[\\s\\S]*\\S)?$";

function isIntentStringNode(ctx: {
  path: (string | number)[];
  jsonSchema: Record<string, unknown>;
}): boolean {
  return (
    ctx.path[ctx.path.length - 1] === "intent" &&
    ctx.jsonSchema.type === "string" &&
    ctx.jsonSchema.maxLength === MAX_INTENT_CHARS
  );
}

/**
 * The JSON Schema document.
 *
 * Built from the STRUCTURAL schema deliberately: refinements do not project
 * into JSON Schema, so generating from the refined validator would silently
 * publish a schema that is weaker than its own name suggests. The description
 * says which rules are missing rather than leaving a consumer to find out.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  1. **`io: "input"`.** The default (`"output"`) describes the value zod
 *     RETURNS, which for a non-strict object is the post-strip shape — so it
 *     emits `additionalProperties: false` for objects the validator actually
 *     accepts-and-strips, publishing a schema stricter than the validator it
 *     documents. This document's job is to validate INPUT files, so it
 *     describes what is ACCEPTED. Step objects now close in the zod source too
 *     (`src/contract/steps.ts`), so `additionalProperties: false` on them is
 *     the validator's real behaviour rather than an artifact of the output
 *     projection. What remains open in both validators is what the contract
 *     genuinely does not own: a tool call's `arguments` object and the reused
 *     predicate union.
 *  2. **The locator `anyOf`.** `elementLocatorSchema`'s "at least one of
 *     role/text/css/testId" is a `.refine()`, and refinements do not project.
 *     Left alone, an editor validating against the published URL would green-
 *     light `target: {}` that the SDK then rejects — tooling passing and the
 *     runtime failing is the worst direction for a divergence, so this one is
 *     encoded rather than documented away. It is expressible in JSON Schema, so
 *     it is expressed.
 */
export function buildEvalSuiteSchemaDocument(
  version: EvalSuiteSchemaVersion = EVAL_SUITE_SCHEMA_VERSION
): Record<string, unknown> {
  const dialect = DIALECTS.find((entry) => entry.version === version)!;
  const generated = z.toJSONSchema(dialect.structural, {
    target: "draft-2020-12",
    io: "input",
    override: (ctx) => {
      const node = ctx.jsonSchema as Record<string, unknown>;
      if (isElementLocatorNode(node)) {
        node.anyOf = ELEMENT_LOCATOR_ANY_OF.map((entry) => ({ ...entry }));
      }
      if (isIntentStringNode(ctx)) {
        node.pattern = INTENT_TRIMMED_PATTERN;
      }
    },
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  // `$schema` first, then identity, then the shape — so a human opening the
  // published file sees what it is before what it contains.
  return {
    $schema,
    $id: dialect.id,
    title: `MCPJam eval suite file (schemaVersion ${dialect.version})`,
    description:
      "Structural contract for an MCPJam eval suite file. Generated from the " +
      "zod source in @mcpjam/sdk (src/contract/suite-file.ts). Describes what " +
      "is ACCEPTED (zod io:input), so a file this schema accepts is one the " +
      "SDK validator also accepts structurally. The zod validator remains the " +
      "authoritative superset: it additionally enforces cross-field rules " +
      "(unique case ids, unique step ids within a case, a per-case import " +
      "block requiring top-level provenance, a per-case import note " +
      "being required when the claimed status is exact, and an OBSERVATION " +
      "check — noDeprecatedToolExposed, noEndingQuestion, noRepeatedIdenticalCall, " +
      "noDeprecatedToolCalled, toolErrorNamesInput, fullPageHasContinuation " +
      '— being refused unless it carries role: "advisory", because a ' +
      "heuristic must not decide a release) and serialized-size caps on " +
      "tool-call arguments and on toolResultMatchesSchema's authored schema, " +
      "none of which JSON Schema can express. " +
      "The authored intent label's already-trimmed invariant is encoded as a " +
      "boundary pattern in the schema. " +
      "Objects the suite file and the step union declare are closed " +
      "(additionalProperties: false). A tool call's own `arguments` object " +
      "and the reused predicate union stay open in both validators: their " +
      "keys are owned by the server's input schema and by a separate " +
      "contract module respectively.",
    ...rest,
  };
}

async function format(source: string, filepath: string): Promise<string> {
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...config, filepath });
}

export type GeneratedArtifact = { path: string; content: string };

/** Every artifact — a `.json` + `.ts` pair per dialect — formatted exactly as it must appear on disk. */
export async function buildEvalSuiteSchemaArtifacts(): Promise<
  GeneratedArtifact[]
> {
  const artifacts: GeneratedArtifact[] = [];
  for (const dialect of DIALECTS) {
    const document = buildEvalSuiteSchemaDocument(dialect.version);
    const jsonName = path.basename(dialect.jsonPath);
    artifacts.push(
      {
        path: dialect.jsonPath,
        content: await format(JSON.stringify(document), dialect.jsonPath),
      },
      {
        path: dialect.tsPath,
        content: await format(
          `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth: src/contract/suite-file.ts (zod).
// Regenerate with:
//   ${REGENERATE_COMMAND}
//
// The identical document is also written to ${jsonName}, which is
// what the schema's $id publishes. This module exists so package consumers can
// import the schema without a JSON import attribute: the contract subpath is
// built by three toolchains (tsup, Vite with the client's src alias, and plain
// tsc) and only Node-only code in this repo uses import attributes.

/**
 * The eval suite file's JSON Schema (draft 2020-12), schemaVersion ${dialect.version}.
 *
 * STRUCTURAL contract only. Cross-field rules the zod validator enforces —
 * unique case ids, unique step ids within a case, a per-case \`import\` block
 * requiring top-level \`provenance\`, and an \`import.note\` being required when
 * \`import.status\` is \`"exact"\` — do not project into JSON Schema.
 * Validate with \`${dialect.validatorName}\` when you have the SDK; use this when you
 * only have a JSON Schema validator.
 */
export const ${dialect.exportName}: Record<string, unknown> =
  ${JSON.stringify(document)};
`,
          dialect.tsPath
        ),
      }
    );
  }
  return artifacts;
}
