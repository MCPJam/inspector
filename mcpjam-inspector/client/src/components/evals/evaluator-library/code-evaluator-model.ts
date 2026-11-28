/**
 * One code evaluator as the Code method's editor drafts and checks it
 * (EFTW-90). The limits are the SDK contract's, so a draft the editor accepts
 * is one the suite save accepts; the platform still checks every save.
 */
import {
  MAX_CODE_EVALUATORS,
  type CodeEvaluatorInput,
} from "@mcpjam/sdk/contract";
import {
  scriptSizeHint,
  totalSizeHint,
  type SuiteScripts,
} from "../code-grading/code-grading-values";

export type CodeEvaluator = CodeEvaluatorInput;
export type CodeEvaluatorRole = NonNullable<CodeEvaluator["role"]>;

/** What the editor holds: every field filled, so a control never reads blank. */
export type CodeEvaluatorDraft = {
  name: string;
  fileName: string;
  script: string;
  role: CodeEvaluatorRole;
  threshold: number;
};

/** The extension picks the interpreter in the grading box. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  py: "Python",
  ts: "TypeScript",
  js: "JavaScript",
  sh: "Bash",
};

const MAX_NAME_LENGTH = 100;
const MAX_FILE_STEM_LENGTH = 100;

export function draftOfCodeEvaluator(
  evaluator: CodeEvaluator | undefined,
): CodeEvaluatorDraft {
  return {
    name: evaluator?.name ?? "",
    fileName: evaluator?.fileName ?? "",
    script: evaluator?.script ?? "",
    // The contract's default: an evaluator nobody marked Required reports.
    role: evaluator?.role ?? "advisory",
    threshold: evaluator?.threshold ?? 1,
  };
}

/** The language a file name runs as, or undefined for one that can't run. */
export function codeLanguageOf(fileName: string): string | undefined {
  const extension = /\.([a-z]+)$/.exec(fileName.trim())?.[1];
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}

export function fileNameProblem(fileName: string): string | undefined {
  const name = fileName.trim();
  if (!name) return "Name the script's file, such as check.py.";
  const match = /^(.*)\.(?:py|ts|js|sh)$/.exec(name);
  if (!match) return "End the file name in .py, .ts, .js or .sh.";
  const stem = match[1];
  if (!/^[A-Za-z0-9]/.test(stem)) {
    return "Start the file name with a letter or digit.";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(stem)) {
    return "Use only letters, digits, dots, dashes and underscores in the file name.";
  }
  if (stem.length > MAX_FILE_STEM_LENGTH) {
    return `Keep the file name to ${MAX_FILE_STEM_LENGTH} characters before the extension.`;
  }
  return undefined;
}

export function scriptProblem(script: string): string | undefined {
  if (!script.trim()) return "Write a script, or pick a starter.";
  return scriptSizeHint(script);
}

export function thresholdProblem(threshold: number): string | undefined {
  return threshold > 0 && threshold <= 1
    ? undefined
    : "Set a passing score above 0 and at most 1.";
}

/** What Test on a past iteration needs: a file that runs, and a score bar. */
export function testableProblem(draft: CodeEvaluatorDraft): string | undefined {
  return (
    fileNameProblem(draft.fileName) ??
    scriptProblem(draft.script) ??
    thresholdProblem(draft.threshold)
  );
}

/**
 * Why the suite can't take this draft, field by field. `others` are the
 * suite's other evaluators and `scripts` its setup and cleanup scripts, which
 * share one size cap with every evaluator.
 */
export function codeEvaluatorProblems(
  draft: CodeEvaluatorDraft,
  others: readonly CodeEvaluator[],
  scripts: SuiteScripts | undefined,
): { name?: string; fileName?: string; script?: string; threshold?: string } {
  const name = draft.name.trim();
  return {
    name: !name
      ? "Give the evaluator a name."
      : name.length > MAX_NAME_LENGTH
        ? `Keep the name to ${MAX_NAME_LENGTH} characters.`
        : undefined,
    fileName: fileNameProblem(draft.fileName),
    script:
      scriptProblem(draft.script) ??
      totalSizeHint(scripts, [...others, { script: draft.script }]),
    threshold: thresholdProblem(draft.threshold),
  };
}

/**
 * A new evaluator's ID, from its file name. The score row is `code:<id>`, so
 * it reads like the script it runs; it is never changed after it is saved.
 */
export function codeEvaluatorIdFor(
  fileName: string,
  taken: readonly string[],
): string {
  const base =
    fileName
      .trim()
      .replace(/\.(?:py|ts|js|sh)$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "code";
  // At most 56 characters plus a short suffix: always a valid ID.
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** The draft as the suite stores it. A passing score of 1 is the default. */
export function toCodeEvaluator(
  draft: CodeEvaluatorDraft,
  identity: Pick<CodeEvaluator, "id" | "evaluator">,
): CodeEvaluator {
  return {
    id: identity.id,
    name: draft.name.trim(),
    fileName: draft.fileName.trim(),
    script: draft.script,
    role: draft.role,
    ...(draft.threshold !== 1 ? { threshold: draft.threshold } : {}),
    ...(identity.evaluator ? { evaluator: identity.evaluator } : {}),
  };
}

/** `evaluators` with `adding` appended, or why the suite can't take them. */
export function codeEvaluatorsWithAdded(
  evaluators: readonly CodeEvaluator[],
  adding: readonly CodeEvaluator[],
): { refused: string } | { refused?: undefined; evaluators: CodeEvaluator[] } {
  const taken = adding.find((next) =>
    evaluators.some((evaluator) => evaluator.id === next.id),
  );
  if (taken) {
    return {
      refused: `Another code evaluator already uses the ID "${taken.id}". Remove it to add this one.`,
    };
  }
  if (evaluators.length + adding.length > MAX_CODE_EVALUATORS) {
    return { refused: CODE_EVALUATOR_LIMIT_COPY };
  }
  return { evaluators: [...evaluators, ...adding] };
}

export const CODE_EVALUATOR_LIMIT_COPY = `Remove a code evaluator to add another. Each suite can have ${MAX_CODE_EVALUATORS} code evaluators.`;

/** One line under an evaluator's name: its file, role and passing score. */
export function codeEvaluatorSummary(evaluator: CodeEvaluator): string {
  const role = evaluator.role === "required" ? "Required" : "Advisory";
  const threshold = evaluator.threshold ?? 1;
  return threshold === 1
    ? `${evaluator.fileName} · ${role}`
    : `${evaluator.fileName} · ${role} · passes at ${threshold}`;
}
