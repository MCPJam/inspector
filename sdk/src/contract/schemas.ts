/**
 * Zod mirrors of the evaluation contract.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * These schemas are the authoring-side validator. Convex hand-mirrors them as
 * `v.*` validators (mutations can never be `'use node'`, and `v.*` arg
 * validators cannot be produced from zod), and the two are proven equal through
 * `sdk/tests/fixtures/score-contract-parity-fixtures.json` — the same mechanism
 * that keeps `predicateSchema` and `convex/lib/predicates.ts` honest.
 *
 * Every object is `.strict()`: Convex `v.object` REJECTS unknown fields, so a
 * permissive Zod schema here would accept a payload the backend refuses, and
 * the parity fixtures would certify two validators that disagree.
 *
 * The `superRefine` clauses are not decoration. `passed` is DERIVED
 * (`value >= passThreshold`), and a payload asserting otherwise is the exact
 * shape a tampered or malformed score set takes: a row claiming
 * `{value: 0.2, passThreshold: 0.7, passed: true}` would, on the
 * `resultSource === "reported"` path, turn a failing run into a passing one.
 * The derivation check is what makes that unrepresentable.
 */

import { z } from "zod";
import { predicateScopeSchema } from "../predicates/types.js";
import { evaluationConfigHash } from "./derive.js";
import {
  MAX_ERROR_LENGTH,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_SCORER_ID_LENGTH,
} from "./types.js";

export const scoreStatusSchema = z.enum([
  "scored",
  "error",
  "skipped",
  "not_applicable",
]);

export const scorerRoleSchema = z.enum(["gating", "advisory"]);

export const scorerErrorPolicySchema = z.enum(["fail", "ignore"]);

export const scorerIdSourceSchema = z.enum([
  "explicit",
  "generated",
  "platform",
]);

/** A score or a threshold: a real number in [0,1]. */
const unitIntervalSchema = z.number().min(0).max(1);

const scoreDefinitionShape = {
  scorerId: z.string().min(1).max(MAX_SCORER_ID_LENGTH),
  idSource: scorerIdSourceSchema,
  scorerVersion: z.string().min(1),
  implementationHash: z.string().min(1),
  label: z.string().min(1).optional(),
  deterministic: z.boolean(),
  passThreshold: unitIntervalSchema,
  role: scorerRoleSchema,
  model: z.string().min(1).optional(),
  scope: predicateScopeSchema.optional(),
};

/** The authored definition: `onError`/`onSkipped` may still be unresolved. */
export const scoreDefinitionSchema = z
  .object({
    ...scoreDefinitionShape,
    onError: scorerErrorPolicySchema.optional(),
    onSkipped: scorerErrorPolicySchema.optional(),
  })
  .strict();

/**
 * The hashing and wire form. Every semantic default is filled, which is what
 * makes an omitted `onError` and an explicitly-configured default digest
 * identically.
 */
export const resolvedScoreDefinitionSchema = z
  .object({
    ...scoreDefinitionShape,
    onError: scorerErrorPolicySchema,
    onSkipped: scorerErrorPolicySchema,
  })
  .strict();

export const scoreResultSchema = z
  .object({
    scorerId: z.string().min(1).max(MAX_SCORER_ID_LENGTH),
    scorerVersion: z.string().min(1),
    definitionHash: z.string().min(1),
    status: scoreStatusSchema,
    value: unitIntervalSchema.optional(),
    passThreshold: unitIntervalSchema,
    passed: z.boolean().optional(),
    rationale: z.string().max(MAX_RATIONALE_LENGTH).optional(),
    evidence: z
      .array(z.string().max(MAX_EVIDENCE_ENTRY_LENGTH))
      .max(MAX_EVIDENCE_ENTRIES)
      .optional(),
    deterministic: z.boolean(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
    error: z.string().min(1).max(MAX_ERROR_LENGTH).optional(),
    scope: predicateScopeSchema.optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.status === "scored") {
      if (row.value === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "`value` is required when status is \"scored\"",
        });
      }
      if (row.passed === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message: "`passed` is required when status is \"scored\"",
        });
      }
      // The load-bearing check: `passed` is derived, never asserted.
      if (row.value !== undefined && row.passed !== undefined) {
        const derived = row.value >= row.passThreshold;
        if (row.passed !== derived) {
          ctx.addIssue({
            code: "custom",
            path: ["passed"],
            message:
              `\`passed\` must equal \`value >= passThreshold\` ` +
              `(${row.value} >= ${row.passThreshold} is ${derived}, got ${row.passed})`,
          });
        }
      }
    } else {
      if (row.value !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: `\`value\` is only allowed when status is "scored"`,
        });
      }
      if (row.passed !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message: `\`passed\` is only allowed when status is "scored"`,
        });
      }
    }

    if (row.status === "error") {
      if (row.error === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["error"],
          message: "`error` is required when status is \"error\"",
        });
      }
    } else if (row.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: `\`error\` is only allowed when status is "error"`,
      });
    }
  });

export const scoreResultArraySchema = z.array(scoreResultSchema);

export const evaluationConfigSnapshotSchema = z
  .object({
    hash: z.string().min(1),
    definitions: z.array(resolvedScoreDefinitionSchema),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    // Duplicate ids make the results→definitions join ambiguous, and an
    // ambiguous join is one where a gating policy can silently resolve to the
    // advisory twin.
    const seen = new Set<string>();
    snapshot.definitions.forEach((definition, index) => {
      if (seen.has(definition.scorerId)) {
        ctx.addIssue({
          code: "custom",
          path: ["definitions", index, "scorerId"],
          message: `duplicate scorerId "${definition.scorerId}"`,
        });
      }
      seen.add(definition.scorerId);
    });

    // The hash must DESCRIBE the definitions it ships with. A snapshot whose
    // hash was computed over a different set is the substitution the integrity
    // model exists to catch, and accepting it here would let the public
    // projection hand a consumer definitions that are not the ones the run
    // graded with.
    const recomputed = evaluationConfigHash(snapshot.definitions);
    if (recomputed !== snapshot.hash) {
      ctx.addIssue({
        code: "custom",
        path: ["hash"],
        message: `evaluationConfigHash mismatch (declared ${snapshot.hash}, recomputed ${recomputed})`,
      });
    }
  });
