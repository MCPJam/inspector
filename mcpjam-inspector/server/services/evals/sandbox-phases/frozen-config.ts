/**
 * The code evaluators, scripts and grading settings a run froze at start
 * (EFTW-90), read off the start response's `configSnapshot` or the run row.
 *
 * The backend validated and normalized every field when the suite was saved
 * (`convex/lib/codeEvaluatorConfig.ts`), so this only narrows unknown JSON to
 * the shapes the runner uses, and drops anything malformed rather than
 * guessing: a run the backend froze is the only source of what it may do.
 */

export type CodeEvaluatorRole = "required" | "advisory";

export type FrozenCodeEvaluator = {
  id: string;
  name?: string;
  fileName: string;
  script: string;
  role: CodeEvaluatorRole;
  /** The score an iteration needs to pass, in (0, 1]. Absent means 1. */
  threshold?: number;
};

export type FrozenScripts = {
  runSetup?: string;
  iterationSetup?: string;
  iterationCleanup?: string;
  runCleanup?: string;
};

export type FrozenGrading = {
  files?: string[];
  network?: "none" | "web";
};

export type FrozenCodeGrading = {
  codeEvaluators: FrozenCodeEvaluator[];
  scripts: FrozenScripts;
  grading: FrozenGrading;
};

export const EMPTY_CODE_GRADING: FrozenCodeGrading = {
  codeEvaluators: [],
  scripts: {},
  grading: {},
};

const SCRIPT_KEYS = [
  "runSetup",
  "iterationSetup",
  "iterationCleanup",
  "runCleanup",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readEvaluator(value: unknown): FrozenCodeEvaluator | null {
  const raw = record(value);
  if (
    typeof raw.id !== "string" ||
    typeof raw.fileName !== "string" ||
    typeof raw.script !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    fileName: raw.fileName,
    script: raw.script,
    role: raw.role === "required" ? "required" : "advisory",
    ...(typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
      ? { threshold: raw.threshold }
      : {}),
  };
}

/** Narrow a `configSnapshot` (or any object carrying the three fields). */
export function readFrozenCodeGrading(snapshot: unknown): FrozenCodeGrading {
  const raw = record(snapshot);
  const codeEvaluators = Array.isArray(raw.codeEvaluators)
    ? raw.codeEvaluators
        .map(readEvaluator)
        .filter((e): e is FrozenCodeEvaluator => e !== null)
    : [];
  const scriptsRaw = record(raw.scripts);
  const scripts: FrozenScripts = {};
  for (const key of SCRIPT_KEYS) {
    if (typeof scriptsRaw[key] === "string" && scriptsRaw[key]) {
      scripts[key] = scriptsRaw[key] as string;
    }
  }
  const gradingRaw = record(raw.grading);
  const files = Array.isArray(gradingRaw.files)
    ? gradingRaw.files.filter((f): f is string => typeof f === "string")
    : [];
  return {
    codeEvaluators,
    scripts,
    grading: {
      ...(files.length ? { files } : {}),
      ...(gradingRaw.network === "web" ? { network: "web" as const } : {}),
    },
  };
}

/** Whether an iteration of this run has any phase work at all. */
export function hasIterationPhases(config: FrozenCodeGrading): boolean {
  return (
    config.codeEvaluators.length > 0 ||
    config.scripts.iterationSetup !== undefined ||
    config.scripts.iterationCleanup !== undefined
  );
}

export function hasRequiredCodeEvaluator(config: FrozenCodeGrading): boolean {
  return config.codeEvaluators.some((e) => e.role === "required");
}

/**
 * What a local-harness run can't honour (EFTW-90, amendment P3): its agent
 * runs on the member's machine, so there is no box to set up, clean up or
 * copy declared files from. Advisory evaluators still grade the transcript.
 */
export function localRunUnsupportedCodeGrading(
  config: FrozenCodeGrading | undefined,
): string[] {
  if (!config) return [];
  return [
    ...(config.scripts.iterationSetup || config.scripts.iterationCleanup
      ? ["iteration setup and cleanup scripts"]
      : []),
    ...(config.grading.files?.length ? ["files declared for grading"] : []),
    ...(hasRequiredCodeEvaluator(config) ? ["Required code evaluators"] : []),
  ];
}
