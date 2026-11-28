/**
 * A suite's setup and cleanup scripts and its grading box settings (EFTW-90),
 * as the settings sheet drafts, checks and describes them.
 *
 * The platform validates and normalizes every save, so the limits here only
 * shape the hints under a field: nothing in this module refuses a save. Blank
 * scripts, an empty file list and `network: "none"` normalize away, so
 * "nothing set" has one spelling in the draft, `undefined`.
 */
import {
  MAX_CODE_SCRIPT_BYTES,
  MAX_CODE_SCRIPTS_TOTAL_BYTES,
  MAX_GRADING_FILES,
  gradingFilePathProblem,
  type SuiteGradingInput,
  type SuiteScriptsInput,
} from "@mcpjam/sdk/contract";

export type SuiteScripts = SuiteScriptsInput;
export type SuiteGrading = SuiteGradingInput;
export type ScriptSlot = keyof SuiteScripts;

/** The fields a suite, or a run that froze them, carries. */
export type CodeGradingConfig = {
  scripts?: SuiteScripts | null;
  grading?: SuiteGrading | null;
  codeEvaluators?: ReadonlyArray<{ role?: string; script?: string }> | null;
};

/** The four slots, in the order they run, with the words the row shows. */
export const SCRIPT_SLOTS: ReadonlyArray<{
  key: ScriptSlot;
  title: string;
  note: string;
}> = [
  {
    key: "runSetup",
    title: "Before the run",
    note: "Runs once, before the first iteration.",
  },
  {
    key: "iterationSetup",
    title: "Before each iteration",
    note: "Runs before the agent starts. If it fails, the iteration is left out of the pass rate.",
  },
  {
    key: "iterationCleanup",
    title: "After each iteration",
    note: "Runs after grading. If it fails, the iteration shows a warning.",
  },
  {
    key: "runCleanup",
    title: "After the run",
    note: "Runs once, after the last iteration.",
  },
];

export function scriptSlotTitle(slot: ScriptSlot): string {
  return SCRIPT_SLOTS.find((entry) => entry.key === slot)?.title ?? slot;
}

/** Rebuilt in run order, so two equal values always compare equal. */
function inRunOrder(
  read: (slot: ScriptSlot) => string | undefined,
): SuiteScripts | undefined {
  const out: SuiteScripts = {};
  for (const { key } of SCRIPT_SLOTS) {
    const text = read(key);
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Scripts as the platform keeps them: blank ones dropped. */
export function normalizeScripts(
  scripts: SuiteScripts | null | undefined,
): SuiteScripts | undefined {
  return inRunOrder((slot) => {
    const text = scripts?.[slot];
    return text?.trim() ? text : undefined;
  });
}

/** `scripts` with one slot set to `text`, or removed when `text` is empty. */
export function withScript(
  scripts: SuiteScripts | undefined,
  slot: ScriptSlot,
  text: string | undefined,
): SuiteScripts | undefined {
  return inRunOrder((key) => (key === slot ? text : scripts?.[key]));
}

export function hasScripts(scripts: SuiteScripts | null | undefined): boolean {
  return normalizeScripts(scripts) !== undefined;
}

function grading(
  files: string[] | undefined,
  web: boolean,
): SuiteGrading | undefined {
  if (!files?.length && !web) return undefined;
  return {
    ...(files?.length ? { files } : {}),
    ...(web ? { network: "web" as const } : {}),
  };
}

/** Grading settings as the platform keeps them: trimmed paths, no blanks. */
export function normalizeGrading(
  value: SuiteGrading | null | undefined,
): SuiteGrading | undefined {
  const files = (value?.files ?? []).map((path) => path.trim()).filter(Boolean);
  return grading(files, value?.network === "web");
}

/** One path per line, kept as typed until the save trims it. */
export function withGradingFiles(
  value: SuiteGrading | undefined,
  text: string,
): SuiteGrading | undefined {
  return grading(text ? text.split("\n") : undefined, value?.network === "web");
}

export function withGradingNetwork(
  value: SuiteGrading | undefined,
  web: boolean,
): SuiteGrading | undefined {
  return grading(value?.files, web);
}

export function hasGrading(value: SuiteGrading | null | undefined): boolean {
  return normalizeGrading(value) !== undefined;
}

/** The draft's two values, read off a suite or normalized for a save. */
export function readCodeGradingValues(source: CodeGradingConfig): {
  scripts: SuiteScripts | undefined;
  grading: SuiteGrading | undefined;
} {
  return {
    scripts: normalizeScripts(source.scripts),
    grading: normalizeGrading(source.grading),
  };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Rounded up, so a script one byte over the cap never reads as the cap. */
function kilobytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** The hint under a script the platform would refuse for its size. */
export function scriptSizeHint(text: string | undefined): string | undefined {
  const bytes = text ? utf8Bytes(text) : 0;
  return bytes > MAX_CODE_SCRIPT_BYTES
    ? `This script is ${kilobytes(bytes)}. A script can be at most ${kilobytes(MAX_CODE_SCRIPT_BYTES)}.`
    : undefined;
}

/** Scripts and code evaluators share one cap on the suite. */
export function totalSizeHint(
  scripts: SuiteScripts | undefined,
  codeEvaluators: CodeGradingConfig["codeEvaluators"],
): string | undefined {
  const bodies = [
    ...SCRIPT_SLOTS.map(({ key }) => scripts?.[key] ?? ""),
    ...(codeEvaluators ?? []).map((evaluator) => evaluator.script ?? ""),
  ];
  const total = bodies.reduce((sum, body) => sum + utf8Bytes(body), 0);
  return total > MAX_CODE_SCRIPTS_TOTAL_BYTES
    ? `Scripts and code evaluators can total at most ${kilobytes(MAX_CODE_SCRIPTS_TOTAL_BYTES)}. These total ${kilobytes(total)}.`
    : undefined;
}

/** Why each declared path would be refused, in the order they are listed. */
export function gradingFileHints(
  files: readonly string[] | undefined,
): string[] {
  const paths = (files ?? []).map((path) => path.trim()).filter(Boolean);
  const hints = paths.flatMap((path) => {
    const problem = gradingFilePathProblem(path);
    const shown = path.length > 60 ? `${path.slice(0, 60)}…` : path;
    return problem ? [`${shown} ${problem}.`] : [];
  });
  return paths.length > MAX_GRADING_FILES
    ? [
        `Copy at most ${MAX_GRADING_FILES} paths. This list has ${paths.length}.`,
        ...hints,
      ]
    : hints;
}

function describeScripts(
  value: SuiteScripts | undefined,
  previous?: SuiteScripts,
): string {
  const slots = SCRIPT_SLOTS.filter(({ key }) => value?.[key]).map(
    ({ key, title }) =>
      previous?.[key] && previous[key] !== value?.[key]
        ? `${title} (edited)`
        : title,
  );
  return slots.length ? slots.join(", ") : "None";
}

function describeGrading(
  value: SuiteGrading | undefined,
  previous?: SuiteGrading,
): string {
  const files = value?.files ?? [];
  const edited =
    previous !== undefined &&
    files.length > 0 &&
    files.length === (previous.files?.length ?? 0) &&
    files.join("\n") !== previous.files?.join("\n");
  const parts = [
    ...(files.length
      ? [
          `${files.length} file${files.length === 1 ? "" : "s"}${edited ? " (edited)" : ""}`,
        ]
      : []),
    ...(value?.network === "web" ? ["web access"] : []),
  ];
  if (!parts.length) return "None";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The review dialog's row for either key: before, and what changed after. */
export function describeCodeGradingChange(
  key: "scripts" | "grading",
  before: Pick<CodeGradingConfig, "scripts" | "grading">,
  after: Pick<CodeGradingConfig, "scripts" | "grading">,
): { label: string; before: string; after: string } {
  if (key === "scripts") {
    const previous = before.scripts ?? undefined;
    return {
      label: "Setup and cleanup",
      before: describeScripts(previous),
      after: describeScripts(after.scripts ?? undefined, previous),
    };
  }
  const previous = before.grading ?? undefined;
  return {
    label: "Grading",
    before: describeGrading(previous),
    after: describeGrading(after.grading ?? undefined, previous),
  };
}

/**
 * What in this config runs in an eval sandbox of its own: every script, and
 * Required code evaluators. Advisory ones don't count: a runner without
 * sandboxes declares them Not run rather than refusing the run.
 */
export function sandboxPhaseNeeds(
  config: CodeGradingConfig | null | undefined,
): string[] {
  return [
    ...(hasScripts(config?.scripts) ? ["setup and cleanup scripts"] : []),
    ...(hasRequiredCodeEvaluator(config) ? ["Required code evaluators"] : []),
  ];
}

/**
 * What needs the agent's own box, so can't run while the agent runs on the
 * member's machine. Run setup and cleanup get boxes of their own.
 */
export function agentBoxNeeds(
  config: CodeGradingConfig | null | undefined,
): string[] {
  const scripts = config?.scripts;
  return [
    ...(scripts?.iterationSetup?.trim() || scripts?.iterationCleanup?.trim()
      ? ["iteration setup and cleanup scripts"]
      : []),
    ...(normalizeGrading(config?.grading)?.files
      ? ["files to copy for grading"]
      : []),
    ...(hasRequiredCodeEvaluator(config) ? ["Required code evaluators"] : []),
  ];
}

function hasRequiredCodeEvaluator(
  config: CodeGradingConfig | null | undefined,
): boolean {
  return (config?.codeEvaluators ?? []).some(
    (evaluator) => evaluator.role === "required",
  );
}

/** "a", "a and b", "a, b and c". */
export function joinNeeds(needs: readonly string[]): string {
  return needs.length < 2
    ? (needs[0] ?? "")
    : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
}
