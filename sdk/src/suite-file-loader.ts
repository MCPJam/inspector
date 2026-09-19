import type {
  SuiteJudgeSettings,
  CaseJudgeSettings,
} from "./contract/judge-settings.js";
/**
 * Read and write eval **suite files** — the loader the contract module says is
 * a separate concern (`./contract/suite-file.ts:7-9`).
 *
 * PURE and browser-safe: text in, text out. No `node:fs`, no `node:path`, no
 * `process`. It lives in the SDK rather than in the CLI because three
 * consumers need it — `mcpjam cloud eval validate`, the importer/mapping work, and a
 * future `validate_eval_suite` agent tool — and a loader that only the CLI can
 * reach forces the other two to re-author it.
 *
 * ── One parser, one code path ────────────────────────────────────────────────
 *
 * YAML is canonical and JSON is accepted, and there is no format sniffing to
 * choose between them: JSON is a subset of YAML 1.2, so the YAML parser reads
 * both. A sniffing branch would be a second code path that can disagree with
 * the first about the same bytes.
 *
 * Exactly ONE document is a suite file. A multi-document stream is rejected
 * rather than having its first document read, because "the file declared three
 * suites and we ran one" is a silent loss of two thirds of an authored
 * artifact.
 *
 * ── Authored vs resolved ─────────────────────────────────────────────────────
 *
 * {@link loadEvalSuiteFile} returns BOTH the validated authored value and an
 * in-memory resolved value with the documented defaults applied onto cases.
 * {@link serializeEvalSuiteFile} accepts only the AUTHORED value. That is the
 * whole mechanism protecting the contract's rule 1 (no `.default()` anywhere):
 * a resolved default has no path back into a file, so a file cannot grow
 * fields nobody wrote by round-tripping through this module.
 *
 * ── Findings ─────────────────────────────────────────────────────────────────
 *
 * Every failure is a {@link SuiteFileFinding}: a stable machine `code`, a field
 * `path`, and a human `message`. Findings are sorted into document order and
 * carry no timestamps, no absolute paths and nothing whose order depends on a
 * filesystem, so two runs over the same bytes emit byte-identical output — the
 * property a CI diff needs and a `Map` iteration order cannot promise.
 */

import { parseAllDocuments, stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import {
  EVAL_SUITE_SCHEMA_VERSION,
  EVAL_SUITE_SCHEMA_VERSION_2,
  EVAL_SUITE_SCHEMA_VERSIONS,
  evalSuiteFileSchema,
  type EvalSuiteFile,
  type EvalSuiteFileCase,
  type EvalSuiteFileCaseImport,
  type EvalSuiteFileCaseV2,
  type EvalSuiteFileDefaults,
  type EvalSuiteFileDefaultsV2,
  type EvalSuiteFileProvenance,
  type EvalSuiteFileTarget,
  type EvalSuiteFileToolPolicy,
  type EvalSuiteFileValidity,
  type EvalSuiteSchemaVersion,
} from "./contract/suite-file.js";
import {
  SUITE_FILE_DEFAULT_COVERAGE,
  SUITE_FILE_VALIDITY_DEFAULTS,
  resolveEvalGradingValidityPolicy,
} from "./contract/grading-policy.js";
import type { EvalValidityCoverage } from "./contract/verdict-policy.js";

// ── the input cap ────────────────────────────────────────────────────────────

/**
 * Largest suite file this loader will parse, in UTF-8 BYTES.
 *
 * Measured in bytes rather than `String.length` for the reason spelled out in
 * the server's `mcpjamYaml.ts`: code units undercount multi-byte text, so a
 * length check admits inputs larger than the bound it is meant to be. A file
 * over the cap is REJECTED, never truncated — a truncated suite file still
 * parses, and describes a smaller suite than the one that was authored.
 */
export const MAX_SUITE_FILE_BYTES = 1_048_576;

// ── documented defaults (contract §"defaults", suite-file.ts:165-179) ─────────

/**
 * The validity defaults, re-exported under the names they ship as.
 *
 * DEFINED in `contract/grading-policy.ts`, because a hosted suite resolves the
 * same three declarations from a different storage shape and the backend
 * mirrors the same table again. Three copies of "omitting `minEligibleTrials`
 * selects the stricter rule" is three places for one of them to become `?? 1`,
 * so the loader resolves through
 * {@link resolveEvalGradingValidityPolicy} and re-exports the constants rather
 * than keeping its own.
 */
export { SUITE_FILE_VALIDITY_DEFAULTS, SUITE_FILE_DEFAULT_COVERAGE };

/** The only implemented capture level, and therefore the resolved default. */
export const SUITE_FILE_DEFAULT_CAPTURE_LEVEL = "full" as const;

// ── findings ─────────────────────────────────────────────────────────────────

/**
 * The stable machine codes a finding can carry.
 *
 * Stable means a consumer may branch on them. New codes are additive; an
 * existing one never changes meaning.
 */
export const SUITE_FILE_FINDING_CODES = [
  /** The input is larger than {@link MAX_SUITE_FILE_BYTES}. Nothing was parsed. */
  "SUITE_FILE_TOO_LARGE",
  /** The input holds no YAML document at all (empty, blank, or comments only). */
  "SUITE_FILE_EMPTY",
  /** The input is not well-formed YAML. */
  "SUITE_FILE_YAML_INVALID",
  /** The input is a multi-document stream; a suite file is exactly one document. */
  "SUITE_FILE_MULTIPLE_DOCUMENTS",
  /** The document parsed, but violates the suite-file contract. */
  "SUITE_FILE_INVALID",
] as const;

export type SuiteFileFindingCode = (typeof SUITE_FILE_FINDING_CODES)[number];

/** One line/column in the source text. Both are 1-based, as editors count. */
export type SuiteFileLocation = {
  line: number;
  column: number;
};

/**
 * One thing wrong with a suite file.
 *
 * `path` is the authoritative machine form — the field path as segments, empty
 * for a finding about the file as a whole. `pointer` is the SAME path rendered
 * for humans as `cases[3].steps[0].id`, and is derived from `path` rather than
 * assembled separately, so the two can never disagree.
 */
export type SuiteFileFinding = {
  code: SuiteFileFindingCode;
  path: Array<string | number>;
  pointer: string;
  message: string;
  /** Where in the source, when the YAML parser located it. */
  location?: SuiteFileLocation;
};

/**
 * How far the loader got. This is what a caller maps onto an exit code:
 * `contract` means the file was read and judged, everything else means nothing
 * was validated.
 */
export type SuiteFileFailureStage = "input" | "parse" | "contract";

// ── the resolved value ───────────────────────────────────────────────────────

/** A case with every suite default resolved onto it. */
export type ResolvedEvalSuiteFileCase = {
  judge?: CaseJudgeSettings;
  id: string;
  title: string;
  /** Authored analytics grouping label; absent remains unlabelled. */
  intent?: string;
  /** Authored case kind; absent means derive from matchOptions. */
  kind?: "capability" | "regression";
  steps: EvalSuiteFileCase["steps"];
  /**
   * The case's assertions — dialect 2's `cases[].assertions`, or dialect 1's
   * `cases[].checks` / its `assertions` alias. One canonical name in memory,
   * whatever the file spelled.
   */
  assertions: NonNullable<EvalSuiteFileCase["checks"]>;
  suppressedSuiteStandardCheckIds?: string[];
  expectedOutput?: string;
  isNegativeTest: boolean;
  /** Resolved from `cases[].model`, else `defaults.model`. */
  model: string;
  /** Resolved from `defaults.provider`; cases cannot override it. */
  provider?: string;
  /**
   * The configured count — dialect 2's `iterations`, dialect 1's
   * `repetitions` — resolved from the case's override, else the suite default.
   * Canonical spelling only: a reader of the resolved view never sees the
   * dialect-1 word.
   */
  iterations: number;
  passThreshold: number;
  /** `true` when the file asks the loader to skip this case. */
  disabled: boolean;
  import?: EvalSuiteFileCaseImport;
};

/** Suite-level validity with the documented defaults applied. */
export type ResolvedEvalSuiteFileValidity = {
  /**
   * The resolved coverage rule — ALWAYS present, and a union rather than an
   * optional number.
   *
   * An optional `minEligibleTrials` here would leave every reader to invent the
   * meaning of absence, and the meaning it invents is `?? 0` or `?? 1`: "no
   * minimum". The contract says omission is a STRICTER rule, not a weaker one
   * (all configured trials attempted, at least one gradeable), so the resolved
   * value names which of the two rules is in force and no defaulting
   * expression downstream gets to decide.
   */
  coverage: EvalValidityCoverage;
  minCompletionRate: number;
  maxEvaluatorErrorRate: number;
};

/**
 * The resolved validity block turned back into the AUTHORED shape — the shape
 * every wire format speaks.
 *
 * WHY THIS EXISTS. {@link resolveEvalSuiteFile} replaces the authored
 * `minEligibleTrials` with a `coverage` union, deliberately, so that no reader
 * downstream can invent a `?? 1` default for an omitted one (see
 * {@link SUITE_FILE_DEFAULT_COVERAGE}). That union is an INTERNAL
 * representation: the suite-file schema does not have it, and neither does the
 * hosted API, whose body validator is strict and rejects the key outright.
 *
 * Handing a resolved block to anything that serializes is therefore always a
 * bug, and it was one — the hosted `eval run --file` path sent
 * `resolved.defaults.validity` and every upload was refused with
 * `Unrecognized key: "coverage"`, whatever the file said, because the resolver
 * emits `coverage` unconditionally. Callers that need to transmit validity get
 * this function instead of reaching into the resolved shape themselves.
 *
 * LOSSLESS BY CONSTRUCTION, in both directions:
 *   - `minEligibleTrials` coverage carries its number back out.
 *   - `allConfiguredTrialsAttempted` OMITS the key, which is precisely what
 *     selected that rule on the way in. The receiver re-resolves omission to
 *     the same stricter rule rather than to a number, so the round trip
 *     preserves the policy rather than approximating it.
 * The two rate fields carry their resolved values explicitly, so a defaults
 * change here can never silently re-decide a policy already sent.
 */
export function declareEvalSuiteFileValidity(
  resolved: ResolvedEvalSuiteFileValidity
): EvalSuiteFileValidity {
  return {
    ...(resolved.coverage.kind === "minEligibleTrials"
      ? { minEligibleTrials: resolved.coverage.minEligibleTrials }
      : {}),
    minCompletionRate: resolved.minCompletionRate,
    maxEvaluatorErrorRate: resolved.maxEvaluatorErrorRate,
  };
}

/**
 * The in-memory view a runner reads: every documented default applied, and
 * every case carrying its effective settings.
 *
 * Deliberately NOT an `EvalSuiteFile`. The two types are different on purpose,
 * so "resolved" can never be handed to {@link serializeEvalSuiteFile} by
 * accident — the compiler refuses it.
 */
export type ResolvedEvalSuiteFile = {
  schemaVersion: EvalSuiteFile["schemaVersion"];
  mode: EvalSuiteFile["mode"];
  reportingMode: EvalSuiteFile["reportingMode"];
  suite: EvalSuiteFile["suite"];
  target: EvalSuiteFileTarget;
  defaults: {
    judge?: SuiteJudgeSettings;
    model: string;
    provider?: string;
    systemPrompt?: string;
    temperature?: number;
    /** The configured count under its canonical name, whatever the dialect. */
    iterations: number;
    passThreshold: number;
    captureLevel: typeof SUITE_FILE_DEFAULT_CAPTURE_LEVEL;
    toolPolicy?: EvalSuiteFileToolPolicy;
    validity: ResolvedEvalSuiteFileValidity;
  };
  provenance?: EvalSuiteFileProvenance;
  /** Every authored case, in file order, including disabled ones. */
  cases: ResolvedEvalSuiteFileCase[];
  /** The cases a run would execute — `cases` without the disabled ones. */
  enabledCases: ResolvedEvalSuiteFileCase[];
};

// ── the load result ──────────────────────────────────────────────────────────

export type SuiteFileLoadSuccess = {
  ok: true;
  /** Exactly what the file declared. The ONLY input the serializer takes. */
  authored: EvalSuiteFile;
  /** The same suite with defaults applied. Never written back to a file. */
  resolved: ResolvedEvalSuiteFile;
  findings: readonly SuiteFileFinding[];
};

export type SuiteFileLoadFailure = {
  ok: false;
  stage: SuiteFileFailureStage;
  findings: readonly SuiteFileFinding[];
};

export type SuiteFileLoadResult = SuiteFileLoadSuccess | SuiteFileLoadFailure;

export type LoadEvalSuiteFileOptions = {
  /**
   * The input's size in UTF-8 bytes, when the caller already knows it.
   *
   * A caller that read a file has the real on-disk byte count, which is the
   * honest number: decoding to a string and re-encoding can differ from it
   * when the bytes were not valid UTF-8. Omitted, the loader measures the text
   * itself with `TextEncoder`.
   */
  byteLength?: number;
};

// ── path rendering ───────────────────────────────────────────────────────────

/** `["cases", 3, "steps", 0, "id"]` → `cases[3].steps[0].id`. */
export function suiteFilePointer(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
      continue;
    }
    out += out === "" ? segment : `.${segment}`;
  }
  return out;
}

/**
 * Document order for two field paths, then code, then message.
 *
 * Sorting explicitly rather than trusting the validator's issue order is what
 * makes the output reproducible: zod's traversal is stable today, but "stable
 * because we sorted" is a property this module owns, and "stable because a
 * dependency happens to iterate that way" is one it merely observes.
 */
function compareFindings(a: SuiteFileFinding, b: SuiteFileFinding): number {
  const length = Math.min(a.path.length, b.path.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.path[index];
    const right = b.path[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    // A numeric segment sorts before a named one at the same depth; the two
    // only ever meet on paths into differently-shaped values, and an arbitrary
    // but FIXED answer is what determinism needs.
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

function finding(
  code: SuiteFileFindingCode,
  path: Array<string | number>,
  message: string,
  location?: SuiteFileLocation
): SuiteFileFinding {
  return {
    code,
    path,
    pointer: suiteFilePointer(path),
    message,
    ...(location ? { location } : {}),
  };
}

function failure(
  stage: SuiteFileFailureStage,
  findings: SuiteFileFinding[]
): SuiteFileLoadFailure {
  return { ok: false, stage, findings: [...findings].sort(compareFindings) };
}

// ── loading ──────────────────────────────────────────────────────────────────

function utf8ByteLength(text: string): number {
  // `TextEncoder` rather than `Buffer`: this module is browser-safe, and
  // `text.length` counts UTF-16 code units, which undercounts every character
  // outside the BMP by half.
  return new TextEncoder().encode(text).length;
}

/**
 * Read one suite file.
 *
 * Never throws for bad input — an invalid file is a RESULT, because a
 * validator whose failure mode is an exception cannot report more than the
 * first thing it found.
 */
export function loadEvalSuiteFile(
  text: string,
  options: LoadEvalSuiteFileOptions = {}
): SuiteFileLoadResult {
  const byteLength = options.byteLength ?? utf8ByteLength(text);
  if (byteLength > MAX_SUITE_FILE_BYTES) {
    return failure("input", [
      finding(
        "SUITE_FILE_TOO_LARGE",
        [],
        `suite file is ${byteLength} bytes, over the ${MAX_SUITE_FILE_BYTES}-byte limit; ` +
          `split it into several files rather than trimming it — this loader never truncates`
      ),
    ]);
  }

  // `parseAllDocuments`, not `parse`: `parse` reads the first document of a
  // stream and discards the rest, which is precisely the silent loss the
  // multi-document rejection below exists to prevent.
  const documents = parseAllDocuments(text, { prettyErrors: true });

  if (documents.length === 0) {
    return failure("parse", [
      finding(
        "SUITE_FILE_EMPTY",
        [],
        "suite file contains no YAML document (it is empty, blank, or only comments)"
      ),
    ]);
  }

  if (documents.length > 1) {
    return failure("parse", [
      finding(
        "SUITE_FILE_MULTIPLE_DOCUMENTS",
        [],
        `suite file contains ${documents.length} YAML documents; a suite file is ` +
          `exactly one document — put each suite in its own file`
      ),
    ]);
  }

  const [document] = documents;
  if (document.errors.length > 0) {
    return failure(
      "parse",
      document.errors.map((error) =>
        finding(
          "SUITE_FILE_YAML_INVALID",
          [],
          error.message,
          locationOfYamlError(error)
        )
      )
    );
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return failure("parse", [
      finding(
        "SUITE_FILE_YAML_INVALID",
        [],
        error instanceof Error ? error.message : String(error)
      ),
    ]);
  }

  const parsed = evalSuiteFileSchema.safeParse(raw);
  if (!parsed.success) {
    return failure("contract", findingsFromZodError(parsed.error, raw));
  }

  const authored = parsed.data;
  return {
    ok: true,
    authored,
    resolved: resolveEvalSuiteFile(authored),
    findings: [],
  };
}

function locationOfYamlError(error: {
  linePos?: [{ line: number; col: number }, ...unknown[]];
}): SuiteFileLocation | undefined {
  const start = error.linePos?.[0];
  if (!start) return undefined;
  return { line: start.line, column: start.col };
}

/**
 * The fields that exist in both dialects under different names.
 *
 * Keyed by the dialect the FILE declared, listing the keys that dialect does
 * not know and the name it uses instead. A strict object refuses the foreign
 * spelling as an unknown key, correctly, but zod's "Unrecognized key" alone
 * sends an author looking for a typo in a word that is spelled right — it is
 * the dialect that is wrong, so the finding says which one spells it that way.
 */
const CROSS_DIALECT_SPELLINGS: Record<
  EvalSuiteSchemaVersion,
  Record<string, { canonical: string; ownedBy: EvalSuiteSchemaVersion }>
> = {
  [EVAL_SUITE_SCHEMA_VERSION]: {
    iterations: {
      canonical: "repetitions",
      ownedBy: EVAL_SUITE_SCHEMA_VERSION_2,
    },
  },
  [EVAL_SUITE_SCHEMA_VERSION_2]: {
    repetitions: {
      canonical: "iterations",
      ownedBy: EVAL_SUITE_SCHEMA_VERSION,
    },
    checks: { canonical: "assertions", ownedBy: EVAL_SUITE_SCHEMA_VERSION },
  },
};

function declaredSchemaVersion(
  raw: unknown
): EvalSuiteSchemaVersion | undefined {
  const declared =
    raw && typeof raw === "object"
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  return (EVAL_SUITE_SCHEMA_VERSIONS as readonly unknown[]).includes(declared)
    ? (declared as EvalSuiteSchemaVersion)
    : undefined;
}

function crossDialectHint(
  issue: z.core.$ZodIssue,
  version: EvalSuiteSchemaVersion | undefined
): string {
  if (version === undefined || issue.code !== "unrecognized_keys") return "";
  const spellings = CROSS_DIALECT_SPELLINGS[version];
  return issue.keys
    .filter((key) => key in spellings)
    .map((key) => {
      const { canonical, ownedBy } = spellings[key]!;
      return (
        ` — schemaVersion "${version}" spells this field \`${canonical}\`; ` +
        `\`${key}\` is the schemaVersion "${ownedBy}" spelling. Rename the key, ` +
        `or set schemaVersion "${ownedBy}"`
      );
    })
    .join("");
}

function findingsFromZodError(
  error: z.ZodError,
  raw: unknown
): SuiteFileFinding[] {
  const version = declaredSchemaVersion(raw);
  return error.issues.map((issue) =>
    finding(
      "SUITE_FILE_INVALID",
      [...issue.path] as Array<string | number>,
      issue.message + crossDialectHint(issue, version)
    )
  );
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * Apply the documented defaults onto a validated suite file.
 *
 * Pure, and separate from parsing, so a caller that already holds an authored
 * value (an importer, a `--file` runner) resolves it without re-reading text.
 */
export function resolveEvalSuiteFile(
  authored: EvalSuiteFile
): ResolvedEvalSuiteFile {
  // The dialects differ in exactly two spellings — the configured count and
  // the rule list — and this is the ONE place that knows it. Everything below
  // reads the canonical names off `authoredCases`, so no other line in this
  // module branches on the dialect.
  const defaults: EvalSuiteFileDefaults | EvalSuiteFileDefaultsV2 =
    authored.defaults;
  const suiteIterations =
    authored.schemaVersion === EVAL_SUITE_SCHEMA_VERSION
      ? authored.defaults.repetitions
      : authored.defaults.iterations;
  const authoredCases: AuthoredCaseView[] =
    authored.schemaVersion === EVAL_SUITE_SCHEMA_VERSION
      ? authored.cases.map((entry) => ({
          ...entry,
          // One list, either spelling. `checks` is dialect 1's canonical word;
          // `assertions` is the original name and still loads. The schema
          // refuses both at once, so this never has to choose between lists.
          assertions: entry.checks ?? entry.assertions,
          iterations: entry.repetitions,
        }))
      : authored.cases;
  const cases = authoredCases.map((authoredCase) =>
    resolveCase(authoredCase, {
      model: defaults.model,
      provider: defaults.provider,
      iterations: suiteIterations,
      passThreshold: defaults.passThreshold,
    })
  );

  return {
    schemaVersion: authored.schemaVersion,
    mode: authored.mode,
    reportingMode: authored.reportingMode,
    suite: authored.suite,
    target: authored.target,
    defaults: {
      ...(defaults.judge === undefined ? {} : { judge: defaults.judge }),
      model: defaults.model,
      ...(defaults.provider === undefined
        ? {}
        : { provider: defaults.provider }),
      ...(defaults.systemPrompt === undefined
        ? {}
        : { systemPrompt: defaults.systemPrompt }),
      ...(defaults.temperature === undefined
        ? {}
        : { temperature: defaults.temperature }),
      iterations: suiteIterations,
      passThreshold: defaults.passThreshold,
      captureLevel: defaults.captureLevel ?? SUITE_FILE_DEFAULT_CAPTURE_LEVEL,
      ...(defaults.toolPolicy === undefined
        ? {}
        : { toolPolicy: defaults.toolPolicy }),
      validity: resolveEvalGradingValidityPolicy(defaults.validity),
    },
    ...(authored.provenance === undefined
      ? {}
      : { provenance: authored.provenance }),
    cases,
    enabledCases: cases.filter((entry) => !entry.disabled),
  };
}

/**
 * A case as the resolver reads it: dialect 2's shape, which is the canonical
 * one. A dialect-1 case is projected onto it before resolution.
 */
type AuthoredCaseView = EvalSuiteFileCaseV2;

/** The suite defaults a case can inherit, already under canonical names. */
type InheritableDefaults = {
  model: string;
  provider: string | undefined;
  iterations: number;
  passThreshold: number;
};

function resolveCase(
  authoredCase: AuthoredCaseView,
  defaults: InheritableDefaults
): ResolvedEvalSuiteFileCase {
  return {
    ...(authoredCase.judge === undefined ? {} : { judge: authoredCase.judge }),
    id: authoredCase.id,
    title: authoredCase.title,
    ...(typeof authoredCase.intent === "string"
      ? { intent: authoredCase.intent }
      : {}),
    ...(authoredCase.kind === "capability" || authoredCase.kind === "regression"
      ? { kind: authoredCase.kind }
      : {}),
    steps: authoredCase.steps,
    assertions: authoredCase.assertions ?? [],
    ...(authoredCase.suppressedSuiteStandardCheckIds !== undefined
      ? {
          suppressedSuiteStandardCheckIds:
            authoredCase.suppressedSuiteStandardCheckIds,
        }
      : {}),
    ...(authoredCase.expectedOutput === undefined
      ? {}
      : { expectedOutput: authoredCase.expectedOutput }),
    isNegativeTest: authoredCase.isNegativeTest ?? false,
    model: authoredCase.model ?? defaults.model,
    ...(defaults.provider === undefined ? {} : { provider: defaults.provider }),
    iterations: authoredCase.iterations ?? defaults.iterations,
    passThreshold: authoredCase.passThreshold ?? defaults.passThreshold,
    disabled: authoredCase.disabled ?? false,
    ...(authoredCase.import === undefined
      ? {}
      : { import: authoredCase.import }),
  };
}

// ── serialization ────────────────────────────────────────────────────────────

/**
 * Key order for the top level and for a case, pinned rather than inherited.
 *
 * An exported file's key order is part of its diff. Taking whatever order the
 * validator's output object happens to carry would make the order an
 * implementation detail of zod, and a zod upgrade would then rewrite every
 * suite file in every repo with a diff that changes nothing.
 */
const FILE_KEY_ORDER = [
  "schemaVersion",
  "mode",
  "reportingMode",
  "suite",
  "target",
  "defaults",
  "provenance",
  "cases",
] as const;

const SUITE_KEY_ORDER = ["id", "name", "description"] as const;
const TARGET_KEY_ORDER = ["servers", "environment"] as const;
const SERVER_KEY_ORDER = ["name", "id"] as const;
/**
 * Per-dialect orders for the two objects whose keys differ by dialect. Same
 * slots, different words: `iterations` sits exactly where `repetitions` did,
 * and `assertions` where `checks` did, so a dialect-2 export reads in the
 * order a dialect-1 author already knows.
 */
const DEFAULTS_KEY_ORDER = [
  "judge",
  "model",
  "provider",
  "repetitions",
  "passThreshold",
  "captureLevel",
  "toolPolicy",
  "validity",
] as const;
const DEFAULTS_KEY_ORDER_V2 = [
  "judge",
  "model",
  "provider",
  "iterations",
  "passThreshold",
  "captureLevel",
  "toolPolicy",
  "validity",
] as const;
const TOOL_POLICY_KEY_ORDER = ["mode", "allow", "deny"] as const;
const VALIDITY_KEY_ORDER = [
  "minEligibleTrials",
  "minCompletionRate",
  "maxEvaluatorErrorRate",
] as const;
const PROVENANCE_KEY_ORDER = [
  "sourceHash",
  "sourceFormat",
  "sourceFormatVersion",
  "converter",
  "converterVersion",
  "model",
  "discoverySnapshotHash",
  "reportHash",
  "importedAt",
] as const;
const CASE_KEY_ORDER = [
  "judge",
  "id",
  "title",
  "intent",
  "kind",
  "disabled",
  "model",
  "repetitions",
  "passThreshold",
  "isNegativeTest",
  "expectedOutput",
  "steps",
  "checks",
  "suppressedSuiteStandardCheckIds",
  // Beside `checks`, its deprecated spelling. A key missing from this list
  // serializes into the remainder AFTER `import`, so an authored `checks`
  // would move on the first write-back and churn the diff.
  "assertions",
  "import",
] as const;
const CASE_KEY_ORDER_V2 = [
  "judge",
  "id",
  "title",
  "intent",
  "kind",
  "disabled",
  "model",
  "iterations",
  "passThreshold",
  "isNegativeTest",
  "expectedOutput",
  "steps",
  "assertions",
  "suppressedSuiteStandardCheckIds",
  "import",
] as const;
const CASE_IMPORT_KEY_ORDER = ["status", "sourceCaseKey", "note"] as const;

/** The key-order tables a dialect serializes with. */
function keyOrdersFor(version: EvalSuiteSchemaVersion) {
  return version === EVAL_SUITE_SCHEMA_VERSION
    ? { defaults: DEFAULTS_KEY_ORDER, testCase: CASE_KEY_ORDER }
    : { defaults: DEFAULTS_KEY_ORDER_V2, testCase: CASE_KEY_ORDER_V2 };
}

type PlainRecord = Record<string, unknown>;

/**
 * Reorder the keys a suite file DECLARES, and drop nothing else.
 *
 * Values the contract leaves open — a tool call's `arguments`, a predicate's
 * body, a widget assertion — pass through untouched, key order included. The
 * ordering here is cosmetic and must stay cosmetic: reordering inside an open
 * object would mean this module has an opinion about a shape it does not own.
 */
function ordered(
  value: PlainRecord,
  keys: readonly string[],
  nested: Record<string, (entry: unknown) => unknown> = {}
): PlainRecord {
  const out: PlainRecord = {};
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined) continue;
    const transform = nested[key];
    out[key] = transform ? transform(entry) : entry;
  }
  // Anything the contract does not declare cannot reach here — every declared
  // object is `.strict()`, so a stray key would have failed validation — but
  // copying the remainder keeps this function honest if that ever changes.
  for (const [key, entry] of Object.entries(value)) {
    if (key in out || entry === undefined) continue;
    out[key] = entry;
  }
  return out;
}

function orderedCase(
  authoredCase: EvalSuiteFileCase | EvalSuiteFileCaseV2,
  caseKeys: readonly string[]
): PlainRecord {
  return ordered(authoredCase as unknown as PlainRecord, caseKeys, {
    import: (entry) => ordered(entry as PlainRecord, CASE_IMPORT_KEY_ORDER),
  });
}

function orderedFile(authored: EvalSuiteFile): PlainRecord {
  // The dialect is the file's own `schemaVersion` — a writer never picks one.
  const keys = keyOrdersFor(authored.schemaVersion);
  return ordered(authored as unknown as PlainRecord, FILE_KEY_ORDER, {
    suite: (entry) => ordered(entry as PlainRecord, SUITE_KEY_ORDER),
    target: (entry) =>
      ordered(entry as PlainRecord, TARGET_KEY_ORDER, {
        servers: (servers) =>
          (servers as PlainRecord[]).map((server) =>
            ordered(server, SERVER_KEY_ORDER)
          ),
      }),
    defaults: (entry) =>
      ordered(entry as PlainRecord, keys.defaults, {
        toolPolicy: (policy) =>
          ordered(policy as PlainRecord, TOOL_POLICY_KEY_ORDER),
        validity: (validity) =>
          ordered(validity as PlainRecord, VALIDITY_KEY_ORDER),
      }),
    provenance: (entry) => ordered(entry as PlainRecord, PROVENANCE_KEY_ORDER),
    cases: (cases) =>
      (cases as Array<EvalSuiteFileCase | EvalSuiteFileCaseV2>).map((entry) =>
        orderedCase(entry, keys.testCase)
      ),
  });
}

/**
 * Write an AUTHORED suite file back to YAML.
 *
 * Takes {@link EvalSuiteFile} and nothing else, which is what makes it
 * structurally impossible to serialize a resolved default: the resolved type
 * is a different type and the compiler refuses it.
 *
 * `aliasDuplicateObjects: false` matters. `yaml` emits an anchor/alias pair
 * when the same OBJECT REFERENCE appears twice, so two cases sharing a step
 * object would serialize as `&a1`/`*a1` — still valid YAML that re-parses
 * equal, but a file whose second case reads as a back-reference to the first
 * is not one a human can edit confidently. `lineWidth: 0` disables folding for
 * the same reason: a long prompt wrapped across lines round-trips fine and
 * reviews terribly.
 */
export function serializeEvalSuiteFile(authored: EvalSuiteFile): string {
  return stringifyYaml(orderedFile(authored), {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  });
}

// ── human rendering ──────────────────────────────────────────────────────────

/**
 * Render findings for a person reading a terminal.
 *
 * The machine form is the finding list itself; this is only a projection of
 * it, so nothing here is parsed by anything.
 */
export function formatSuiteFileFindings(
  findings: readonly SuiteFileFinding[]
): string {
  if (findings.length === 0) return "Suite file is valid.";
  return findings
    .map((entry) => {
      const where = entry.pointer === "" ? "" : ` ${entry.pointer}:`;
      const at = entry.location
        ? ` (line ${entry.location.line}, column ${entry.location.column})`
        : "";
      return `  ${entry.code}${where} ${entry.message}${at}`;
    })
    .join("\n");
}
