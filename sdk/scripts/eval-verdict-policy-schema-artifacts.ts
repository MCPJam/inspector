/**
 * The two generated verdict-policy schema artifacts, built from the zod source.
 *
 * Same split as `./eval-suite-schema-artifacts.ts` and for the same reason: one
 * builder, called by both the CLI (`generate-eval-verdict-policy-schema.ts`) and
 * `tests/eval-verdict-policy-schema-json.test.ts`, so "what CI checks" and
 * "what the generator writes" cannot drift.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { z } from "zod";
import {
  EVAL_VERDICT_POLICY_SCHEMA_ID,
  EVAL_VERDICT_POLICY_VERSION,
  evalVerdictDecisionStructuralSchema,
} from "../src/contract/verdict-policy.js";

const contractDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/contract"
);

/** The artifact published at the schema's `$id`. */
export const EVAL_VERDICT_POLICY_SCHEMA_JSON_PATH = path.join(
  contractDir,
  "eval-verdict-policy.schema.json"
);
/** The TS twin `@mcpjam/sdk/contract` re-exports. */
export const EVAL_VERDICT_POLICY_SCHEMA_TS_PATH = path.join(
  contractDir,
  "eval-verdict-policy.schema.generated.ts"
);

export const REGENERATE_COMMAND =
  "npm run generate:eval-verdict-policy-schema -w @mcpjam/sdk";

/**
 * The JSON Schema document.
 *
 * Built from the STRUCTURAL schema, because that is the half that projects:
 * every arithmetic rule in this contract (a rate is the quotient of its counts,
 * a verdict follows from the counts, validity is evaluated before the task
 * verdict) is a zod refinement with no JSON Schema equivalent. Generating from
 * the refined validator would publish a document that silently accepts a
 * self-contradictory decision, so the `description` names what is missing
 * instead of implying it is enforced.
 *
 * `io: "input"` for the same reason as the suite-file schema: this document
 * describes what is ACCEPTED, and the output projection would emit
 * `additionalProperties: false` as an artifact of stripping rather than as the
 * validator's real behaviour. Here every object is `.strict()` in the zod
 * source anyway, so closed means closed in both.
 */
export function buildEvalVerdictPolicySchemaDocument(): Record<
  string,
  unknown
> {
  const generated = z.toJSONSchema(evalVerdictDecisionStructuralSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: EVAL_VERDICT_POLICY_SCHEMA_ID,
    title: `MCPJam eval run verdict decision (verdictPolicyVersion ${EVAL_VERDICT_POLICY_VERSION})`,
    description:
      "Structural contract for an MCPJam eval run verdict decision. " +
      "Generated from the zod source in @mcpjam/sdk " +
      "(src/contract/verdict-policy.ts). Describes what is ACCEPTED (zod " +
      "io:input). The zod validator `evalVerdictDecisionSchema` is the " +
      "authoritative superset: it additionally enforces every arithmetic and " +
      "ordering rule that JSON Schema cannot express — a rate's `value` is " +
      "exactly `numerator / denominator`, passed + failed trials equal " +
      "eligible trials, each rate's denominator is the population it names, " +
      "`mixedVerdict` is true exactly when both a pass and a fail were " +
      "graded, `observedStability` is max(passed, failed) over eligible, a " +
      "case with zero eligible trials is inconclusive whatever its " +
      "threshold, validity is decided BEFORE the task verdict and a run whose " +
      "validity fails is inconclusive with validity-only reasons, and a " +
      "measured case passes exactly when its pass rate is greater than or " +
      "equal to its effective threshold. What this document does pin " +
      "structurally: every object is closed (additionalProperties: false), " +
      "every fraction is a finite number in [0,1] so percents are rejected, " +
      "and a rate with a zero denominator is representable only as the " +
      "`notMeasured` branch with a null value. `verdictPolicyVersion` is a " +
      "required const: a payload without it is a LEGACY (percent-threshold) " +
      "row and is not described by this schema.",
    ...rest,
  };
}

async function format(source: string, filepath: string): Promise<string> {
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...config, filepath });
}

export type GeneratedArtifact = { path: string; content: string };

/** Both artifacts, formatted exactly as they must appear on disk. */
export async function buildEvalVerdictPolicySchemaArtifacts(): Promise<
  GeneratedArtifact[]
> {
  const document = buildEvalVerdictPolicySchemaDocument();
  return [
    {
      path: EVAL_VERDICT_POLICY_SCHEMA_JSON_PATH,
      content: await format(
        JSON.stringify(document),
        EVAL_VERDICT_POLICY_SCHEMA_JSON_PATH
      ),
    },
    {
      path: EVAL_VERDICT_POLICY_SCHEMA_TS_PATH,
      content: await format(
        `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source of truth: src/contract/verdict-policy.ts (zod).
// Regenerate with:
//   ${REGENERATE_COMMAND}
//
// The identical document is also written to eval-verdict-policy.schema.json,
// which is what the schema's $id publishes. This module exists so package
// consumers can import the schema without a JSON import attribute: the contract
// subpath is built by three toolchains (tsup, Vite with the client's src alias,
// and plain tsc) and only Node-only code in this repo uses import attributes.

/**
 * The eval run verdict decision's JSON Schema (draft 2020-12).
 *
 * STRUCTURAL contract only. Every arithmetic and phase-ordering rule the zod
 * validator enforces — a rate equalling its own quotient, a verdict following
 * from the trial counts, validity being decided before the task verdict — does
 * not project into JSON Schema. Validate with \`evalVerdictDecisionSchema\` when
 * you have the SDK; use this when you only have a JSON Schema validator.
 */
export const evalVerdictPolicyJsonSchema: Record<string, unknown> =
  ${JSON.stringify(document)};
`,
        EVAL_VERDICT_POLICY_SCHEMA_TS_PATH
      ),
    },
  ];
}
