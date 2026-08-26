/**
 * The versioned eval **suite file** — one declarative document describing a
 * suite, its defaults, and its cases.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * This file is the CONTRACT, not the loader. It says what a valid suite file
 * is; reading YAML, resolving defaults onto cases, and `eval validate` are a
 * separate concern that consumes these schemas. Two rules follow from that
 * split and are load-bearing:
 *
 *  1. **No `.default()` anywhere.** An omitted field stays omitted, so
 *     `parse(x)` is byte-stable through `canonicalJson` and back. Default
 *     *semantics* are documented in the JSDoc beside each field and applied by
 *     the loader; materializing them here would mean a file grows fields it
 *     never declared every time it round-trips, and the diff of an unchanged
 *     suite would be full of values nobody wrote.
 *  2. **Every object this file DECLARES is `.strict()`, and so is every object
 *     the step union declares.** A mis-mapped import field must fail loudly
 *     rather than be silently dropped — the failure mode this schema exists to
 *     prevent is an importer that "succeeds" while quietly discarding half of
 *     what it read. Strictness also matches Convex `v.object`, which rejects
 *     unknown fields, so a permissive schema here would accept payloads the
 *     backend refuses.
 *
 *     `stepsSchema` closed with this file (see `./steps.ts`), because step
 *     level is where a mis-mapped import field actually lands and leaving it
 *     open reproduced the whole failure one level down. Two reused things stay
 *     open on purpose: a tool call's own `arguments` object, whose keys belong
 *     to the server's input schema rather than to this contract, and
 *     `predicateSchema`, which is a separate contract module with its own
 *     mirror, its own fixtures and many more authoring surfaces — closing it is
 *     a change made THERE, with its own consumer audit, not a side effect of
 *     adding a file format. What IS guaranteed is that the generated JSON
 *     Schema describes the same behaviour (see the generator's `io: "input"`
 *     note): the two validators never disagree about which files they accept,
 *     even where they are both permissive.
 *
 * ── Reserved values are ERRORS, not ignored ─────────────────────────────────
 *
 * `mode`, `reportingMode` and `captureLevel` each have values reserved for
 * capabilities that do not exist yet. Every one of them is a VALIDATION ERROR
 * in `schemaVersion` 1. Accepting-and-ignoring a reserved value is the worst
 * available outcome: a file that says `captureLevel: "none"` and captures
 * everything is a privacy incident with a paper trail claiming otherwise.
 * Because they are expressed as `z.literal`, the generated JSON Schema emits
 * `const` and rejects them structurally too.
 *
 * ── Versioning policy ────────────────────────────────────────────────────────
 *
 * `schemaVersion` is `const "1"`. Additive OPTIONAL fields stay within `"1"`; a
 * breaking revision becomes `"2"`. A v1 validator handed a `"2"` file says so in
 * words that name the fix ("upgrade the CLI/SDK"), because the alternative — a
 * generic "invalid enum value" — sends people to edit a file that is correct.
 */

import { z } from "zod";
import { predicateSchema } from "../predicates/types.js";
import { importMappingStatusSchema } from "./chain.js";
import { opaqueIdSchema } from "./identity.js";
import { stepsSchema } from "./steps.js";

/** The only `schemaVersion` this validator accepts. */
export const EVAL_SUITE_SCHEMA_VERSION = "1";

/** The `$id` of the published JSON Schema for this contract. */
export const EVAL_SUITE_SCHEMA_ID =
  "https://mcpjam.com/schemas/eval-suite/v1.json";

// ── caps ─────────────────────────────────────────────────────────────────────
/**
 * Max cases in ONE suite file.
 *
 * Deliberately LARGER than the hosted batch-create cap (100 per call): a file
 * is an authored artifact and a repo of 400 cases is one suite, while a batch
 * call is a request bound by request size. A max-size file therefore uploads in
 * several batch calls. The two numbers are not meant to match — do not "align"
 * them.
 */
export const MAX_SUITE_FILE_CASES = 500;
/**
 * Max cases the hosted batch-create surface accepts in ONE call.
 *
 * The other half of the note above, kept beside it so the two numbers are read
 * together and neither drifts toward the other. Mirrored by
 * `MAX_TEST_CASES_PER_BATCH` in the platform's own batch mutation, which is
 * where the limit is enforced; this copy is what lets a client CHUNK to the
 * limit instead of discovering it from a rejected call.
 */
export const MAX_BATCH_CREATE_CASES = 100;
/** Max characters in a suite name or a case title. */
export const MAX_SUITE_FILE_TITLE_CHARS = 200;
/** Max transcript predicates attached to one case. */
export const MAX_CASE_ASSERTIONS = 50;
/** Max repetitions per case (suite default or per-case override). */
export const MAX_REPETITIONS = 100;
/**
 * Max characters in `import.sourceCaseKey` — the case's identity in the source
 * system. Generous because a source key is a path-like string from somebody
 * else's test runner (`tests/billing/refunds_test.py::test_partial[eu]`), and
 * a cap that truncates lineage is worse than one that never binds.
 *
 * Mirrored by `MAX_IMPORT_SOURCE_CASE_KEY_CHARS` in the platform's own
 * hand-written validator; the two must agree or a file that loads locally is
 * rejected at ingest.
 */
export const MAX_IMPORT_SOURCE_CASE_KEY_CHARS = 512;
/**
 * Max characters in `import.note` — the cited mapping rule, or what was lost.
 *
 * A bound, not a budget: the note is prose a human reads while deciding whether
 * a converted case still means what the source meant. The full mapping report
 * lives in the author's Git repo, so nothing here is the only copy.
 */
export const MAX_IMPORT_NOTE_CHARS = 2000;

/** A rate or a threshold: a real number in [0,1]. Never a percent. */
const unitIntervalSchema = z.number().min(0).max(1);

const repetitionsSchema = z.number().int().min(1).max(MAX_REPETITIONS);

/**
 * Build the error message for a reserved-value literal.
 *
 * Two distinct messages, because they send the reader to two different places:
 * a RESERVED value means "this capability is not built yet, stop planning
 * around it"; anything else is an ordinary typo.
 */
function reservedLiteralError(
  field: string,
  supported: string,
  reserved: readonly string[]
) {
  return (issue: { input: unknown }): string => {
    const received = issue.input;
    if (typeof received === "string" && reserved.includes(received)) {
      return (
        `${field} "${received}" is reserved and not accepted in schemaVersion ` +
        `${EVAL_SUITE_SCHEMA_VERSION}; the only supported ${field} is "${supported}"`
      );
    }
    return (
      `${field} must be "${supported}" in schemaVersion ` +
      `${EVAL_SUITE_SCHEMA_VERSION} (received ${JSON.stringify(received)}); ` +
      `"${reserved.join('", "')}" are reserved for a future version`
    );
  };
}

/** Reserved for a future server-contract mode (no agent in the loop). */
export const RESERVED_MODES = ["serverContract"] as const;
/** Reserved for future redacted/summarized reporting. */
export const RESERVED_REPORTING_MODES = ["restricted", "summary"] as const;
/** Reserved for future reduced-capture policies. */
export const RESERVED_CAPTURE_LEVELS = ["metadataOnly", "none"] as const;

// ── target ───────────────────────────────────────────────────────────────────
/**
 * One server this suite runs against.
 *
 * `id` is the stable project-server reference and WINS when both are present;
 * `name` is the display fallback for environments with no bindings. Same
 * precedence as `toolCallStep`'s `serverId`/`serverName`, deliberately — a
 * suite file and a step must not disagree about how a server is addressed.
 */
export const evalSuiteFileServerSchema = z
  .object({
    name: z.string().min(1).max(MAX_SUITE_FILE_TITLE_CHARS),
    id: opaqueIdSchema.optional(),
  })
  .strict();
export type EvalSuiteFileServer = z.infer<typeof evalSuiteFileServerSchema>;

/**
 * One hosted client attachment.
 *
 * `id` wins over `name`, matching server references. `servers` is the closed
 * server set attached to this host; an empty set is meaningful and preserved.
 */
export const evalSuiteFileHostSchema = z
  .object({
    name: z.string().min(1).max(MAX_SUITE_FILE_TITLE_CHARS),
    id: opaqueIdSchema.optional(),
    servers: z.array(evalSuiteFileServerSchema).optional(),
  })
  .strict();
export type EvalSuiteFileHost = z.infer<typeof evalSuiteFileHostSchema>;

const targetHostFields = {
  hosts: z.array(evalSuiteFileHostSchema).min(1).optional(),
};

/**
 * A target always names at least one legacy server or one project environment.
 * Host attachments augment that target; hosts alone are not a runnable target.
 */
export const evalSuiteFileTargetSchema = z.union([
  z
    .object({
      servers: z.array(evalSuiteFileServerSchema).min(1),
      /** Named run environment; the loader resolves what it means. */
      environment: z.string().min(1).optional(),
      ...targetHostFields,
    })
    .strict(),
  z
    .object({
      servers: z.array(evalSuiteFileServerSchema).min(1).optional(),
      /** Named run environment; the loader resolves what it means. */
      environment: z.string().min(1),
      ...targetHostFields,
    })
    .strict(),
]);
export type EvalSuiteFileTarget = z.infer<typeof evalSuiteFileTargetSchema>;

// ── defaults ─────────────────────────────────────────────────────────────────
/**
 * When a run's verdict is allowed to MEAN anything.
 *
 * All members are optional here and the file materializes none of them, but the
 * semantics are pinned so a loader is accountable to this file rather than to
 * memory:
 *
 *   - `minEligibleTrials`     — no numeric default, but ABSENT IS NOT "no
 *     minimum". Omission selects the default coverage floor: every configured
 *     trial must have been attempted, and the suite must have at least one
 *     gradeable trial. An explicit `N` REPLACES that floor with
 *     `eligibleTrials >= N`, which deliberately tolerates unattempted trials.
 *   - `minCompletionRate`     — defaults to **0.8**.
 *   - `maxEvaluatorErrorRate` — defaults to **0.1**.
 *
 * The three are INDEPENDENT checks; the loader resolves the coverage rule into
 * `ResolvedEvalSuiteFileValidity.coverage`, and
 * `contract/verdict-policy.ts` is where a verdict is decided against it.
 *
 * A run that misses any of these is INVALID, which is not the same as failed: a
 * suite whose judge errored on half its iterations has not measured the server,
 * and reporting that as a failure blames the server for the grader. Reading
 * omission as "no minimum" is the same bug in a quieter form: it lets a suite
 * that ran one trial out of thirty report a confident pass.
 */
export const evalSuiteFileValiditySchema = z
  .object({
    minEligibleTrials: z.number().int().min(1).optional(),
    minCompletionRate: unitIntervalSchema.optional(),
    maxEvaluatorErrorRate: unitIntervalSchema.optional(),
  })
  .strict();
export type EvalSuiteFileValidity = z.infer<typeof evalSuiteFileValiditySchema>;

/**
 * Which tools the agent is RESTRAINED from calling.
 *
 * `mode` does the restraining: `readOnly` permits only tools an annotation
 * classifies read-only, `default` permits everything except tools annotated
 * `destructiveHint`. `deny` removes a tool by name under either mode.
 *
 * `allow` is an OVERRIDE, not a whitelist — it exempts a named tool from the
 * mode-derived rules (including `default` mode's destructive deny-by-default),
 * and it never restricts anything on its own. `{ mode: "default", allow:
 * ["read_file"] }` therefore restrains NOTHING; the tools an author wants
 * stopped belong in `deny`, or the suite belongs in `readOnly` mode. Stated
 * here because reading `allow` as "the only tools the agent may call" is the
 * one misreading that silently produces an unrestricted run.
 *
 * `allow`/`deny` entries are non-empty tool names; the empty string is rejected
 * structurally (rather than in a refinement) so the generated JSON Schema
 * rejects it too — an empty entry in a deny list reads as "deny nothing" to a
 * naive matcher and as "deny everything" to a prefix matcher.
 */
export const evalSuiteFileToolPolicySchema = z
  .object({
    mode: z.enum(["default", "readOnly"]),
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type EvalSuiteFileToolPolicy = z.infer<
  typeof evalSuiteFileToolPolicySchema
>;

export const evalSuiteFileDefaultsSchema = z
  .object({
    /** Model id every case runs with unless it overrides `model`. */
    model: z.string().min(1),
    /** Optional provider hint when the model id alone is ambiguous. */
    provider: z.string().min(1).optional(),
    /** Suite execution instructions. Omitted means use the platform default. */
    systemPrompt: z.string().optional(),
    /** Suite execution temperature. Omitted means use the platform default. */
    temperature: z.number().optional(),
    /** Iterations per case unless the case overrides `repetitions`. */
    repetitions: repetitionsSchema,
    /** Fraction of iterations a case must pass to pass. Never a percent. */
    passThreshold: unitIntervalSchema,
    validity: evalSuiteFileValiditySchema,
    toolPolicy: evalSuiteFileToolPolicySchema.optional(),
    /**
     * How much of a run is captured. `"full"` is the only level implemented;
     * `"metadataOnly"` and `"none"` are reserved and rejected — see the module
     * docblock on why a reserved capture level can never be accepted-and-ignored.
     */
    captureLevel: z
      .literal("full", {
        error: reservedLiteralError(
          "captureLevel",
          "full",
          RESERVED_CAPTURE_LEVELS
        ),
      })
      .optional(),
  })
  .strict();
export type EvalSuiteFileDefaults = z.infer<typeof evalSuiteFileDefaultsSchema>;

// ── provenance (import audit trail) ──────────────────────────────────────────
/**
 * Where an imported suite came from — the POINTER, not the report.
 *
 * The detailed mapping report is a separate artifact linked by `reportHash`, so
 * a suite file stays readable and diffable no matter how verbose the converter
 * was. `sourceHash` is what makes a re-import identifiable: the same source
 * bytes converted twice are the same import, and a changed `sourceHash` with an
 * unchanged suite is a re-import that needs auditing.
 */
export const evalSuiteFileProvenanceSchema = z
  .object({
    /** Digest of the source artifact this suite was converted from. */
    sourceHash: z.string().min(1),
    /** The source format's name (e.g. an upstream eval framework). */
    sourceFormat: z.string().min(1),
    sourceFormatVersion: z.string().min(1).optional(),
    /** The converter that produced this file, and its version. */
    converter: z.string().min(1).optional(),
    converterVersion: z.string().min(1).optional(),
    /** The model that assisted the conversion, when one did. */
    model: z.string().min(1).optional(),
    /** Digest of the tool/resource discovery snapshot the mapping read. */
    discoverySnapshotHash: z.string().min(1).optional(),
    /** Digest of the detailed mapping report. Required: see the docblock. */
    reportHash: z.string().min(1),
    importedAt: z.iso.datetime().optional(),
  })
  .strict();
export type EvalSuiteFileProvenance = z.infer<
  typeof evalSuiteFileProvenanceSchema
>;

/**
 * Per-case import record.
 *
 * `status` is CALLER-SUPPLIED and pessimistic: `exact` is a claim that must be
 * earned by a cited structural rule, and a converter that cannot cite one
 * records `approximated`. Absence of this whole block means the case was
 * authored natively — the file schema deliberately does NOT default a status,
 * because "no import block" and "imported, faithfulness unknown" are different
 * facts and a default would erase the difference.
 */
export const evalSuiteFileCaseImportSchema = z
  .object({
    status: importMappingStatusSchema,
    /** The case's identity in the source system, when it had one. */
    sourceCaseKey: z
      .string()
      .min(1)
      .max(MAX_IMPORT_SOURCE_CASE_KEY_CHARS)
      .optional(),
    /** Why the status is what it is — the rule cited, or what was lost. */
    note: z.string().min(1).max(MAX_IMPORT_NOTE_CHARS).optional(),
  })
  .strict()
  .refine((value) => value.status !== "exact" || value.note !== undefined, {
    // `exact` is the one status that asks a reader to stop looking. It is a
    // CONVERTER CLAIM, never an MCPJam verification, so it has to cite the
    // structural rule that earns it; a converter with no rule to cite
    // records `approximated` and describes the difference instead.
    message:
      'import.note is required when status is "exact": an exact claim is ' +
      "converter-asserted, not verified, so it must cite the mapping rule " +
      'that earns it. Record "approximated" with a note describing the ' +
      "difference when no rule can be cited.",
    path: ["note"],
  });
export type EvalSuiteFileCaseImport = z.infer<
  typeof evalSuiteFileCaseImportSchema
>;

// ── cases ────────────────────────────────────────────────────────────────────
/**
 * One case.
 *
 * **`id` is the identity; `title` is display text.** They are never derived
 * from each other and never swapped: history joins on `id`, so a case renamed
 * from "Refund flow" to "Refunds" is the SAME case with the same history. That
 * is the entire reason `id` exists as a separate required field rather than
 * being hashed out of the title.
 */
export const evalSuiteFileCaseSchema = z
  .object({
    id: opaqueIdSchema,
    title: z.string().min(1).max(MAX_SUITE_FILE_TITLE_CHARS),
    /**
     * The authored steps, reused VERBATIM from the canonical step union — this
     * is not a suite-file dialect of steps. Step `id`s are therefore required
     * here too: they carry per-step history and make the round-trip exact.
     * Agents and exporters mint them.
     */
    steps: stepsSchema.min(1),
    /**
     * Case-level transcript predicates, from the existing predicate corpus. No
     * new predicate kinds are introduced by the suite file.
     */
    assertions: z.array(predicateSchema).max(MAX_CASE_ASSERTIONS).optional(),
    /** Reference output for judge scorers. */
    expectedOutput: z.string().optional(),
    /** The case passes only when NO tool was called. */
    isNegativeTest: z.boolean().optional(),
    /** Per-case overrides of the suite defaults. */
    model: z.string().min(1).optional(),
    repetitions: repetitionsSchema.optional(),
    passThreshold: unitIntervalSchema.optional(),
    /** Present and true: the loader skips this case (it stays in the file). */
    disabled: z.boolean().optional(),
    import: evalSuiteFileCaseImportSchema.optional(),
  })
  .strict();
export type EvalSuiteFileCase = z.infer<typeof evalSuiteFileCaseSchema>;

// ── the file ─────────────────────────────────────────────────────────────────
const evalSuiteFileObjectSchema = z
  .object({
    schemaVersion: z.literal(EVAL_SUITE_SCHEMA_VERSION, {
      error: (issue: { input: unknown }) =>
        `schemaVersion ${JSON.stringify(issue.input)} is not supported by ` +
        `this validator, which reads schemaVersion ` +
        `"${EVAL_SUITE_SCHEMA_VERSION}". This file needs a newer CLI/SDK — ` +
        `upgrade @mcpjam/cli or @mcpjam/sdk rather than editing the file.`,
    }),
    /**
     * What kind of evaluation this is. `"agentWorkflow"` — a model driving the
     * server — is the only kind implemented; `"serverContract"` is reserved.
     */
    mode: z.literal("agentWorkflow", {
      error: reservedLiteralError("mode", "agentWorkflow", RESERVED_MODES),
    }),
    /**
     * How much of the run is reported. `"standard"` is the only level
     * implemented; `"restricted"` and `"summary"` are reserved.
     */
    reportingMode: z.literal("standard", {
      error: reservedLiteralError(
        "reportingMode",
        "standard",
        RESERVED_REPORTING_MODES
      ),
    }),
    suite: z
      .object({
        id: opaqueIdSchema,
        name: z.string().min(1).max(MAX_SUITE_FILE_TITLE_CHARS),
        description: z.string().optional(),
      })
      .strict(),
    target: evalSuiteFileTargetSchema,
    defaults: evalSuiteFileDefaultsSchema,
    provenance: evalSuiteFileProvenanceSchema.optional(),
    cases: z.array(evalSuiteFileCaseSchema).min(1).max(MAX_SUITE_FILE_CASES),
  })
  .strict();

/**
 * The suite-file validator.
 *
 * The cross-field rules below are expressed as refinements, which means they do
 * NOT project into the generated JSON Schema. That is stated rather than
 * hidden: the JSON Schema is the STRUCTURAL contract for third-party tooling,
 * and this zod schema is the authoritative superset. Anything that must be
 * enforced by both lives in the object shape above.
 *
 * What is deliberately NOT enforced here:
 *
 *  - **"a non-`exact` import must be `disabled`".** Import eligibility is
 *    runtime policy — an audited case can legitimately be enabled while still
 *    recorded as `approximated`. Encoding it structurally would make an audited
 *    acceptance unrepresentable, so the file could not express the outcome the
 *    audit exists to produce.
 *  - **negative-case ⇄ `toolCalledWith` contradictions.** That is semantic
 *    validation over predicate content, and it already exists in the corpus
 *    guard; a second implementation here would be a second thing to keep in
 *    sync.
 */
export const evalSuiteFileSchema = evalSuiteFileObjectSchema.superRefine(
  (file, ctx) => {
    // Duplicate case ids make the results→case join ambiguous, and an ambiguous
    // identity join is one where a case silently inherits another's history.
    const seenCaseIds = new Set<string>();
    file.cases.forEach((testCase, index) => {
      if (seenCaseIds.has(testCase.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `duplicate case id "${testCase.id}"`,
        });
      }
      seenCaseIds.add(testCase.id);

      const seenStepIds = new Set<string>();
      testCase.steps.forEach((step, stepIndex) => {
        if (seenStepIds.has(step.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["cases", index, "steps", stepIndex, "id"],
            message: `duplicate step id "${step.id}" in case "${testCase.id}"`,
          });
        }
        seenStepIds.add(step.id);
      });

      // A mapping status with no report to point at is unauditable: it asserts
      // a faithfulness claim while withholding the evidence for it.
      if (testCase.import && !file.provenance) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "import"],
          message:
            `case "${testCase.id}" records an import status but the file has ` +
            `no top-level \`provenance\`, so the mapping cannot be audited`,
        });
      }
    });
  }
);

export type EvalSuiteFile = z.infer<typeof evalSuiteFileSchema>;

/**
 * The strictly-structural half of the contract, without the cross-field
 * refinements.
 *
 * Exported for ONE purpose: generating the JSON Schema, and proving in a test
 * that the generated schema and the zod validator agree on everything that is
 * structural. Validate real files with {@link evalSuiteFileSchema}.
 */
export const evalSuiteFileStructuralSchema = evalSuiteFileObjectSchema;
