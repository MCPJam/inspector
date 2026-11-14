/**
 * Answers checked the way the portal checks them, with the portal's words.
 *
 * Two entry points with different jobs. `validateDirectoryAnswerInput` is the
 * gate before a write: it refuses only what the portal's own controls could
 * never hold (an unknown field, a list where text goes, an option it does not
 * offer, more rows than it shows, anything but a secret's name in a secret
 * field, a person's write to a field the package manages). Everything the
 * portal lets a person type and then complains about — a missing answer, a
 * one-liner over its counter, a link that is not https — is stored, and
 * `validateDirectoryAnswers` reports it, as the portal's form and review page
 * do.
 *
 * Pure. Safe from the browser entry.
 */

import {
  directoryFieldWordingRevision,
  directoryFlowField,
  isBlankAnswer,
  withDirectoryFlowDefaults,
} from "./fields.js";
import type {
  DirectoryAnswer,
  DirectoryAnswerOrigin,
  DirectoryAnswerValue,
  DirectoryFieldFormat,
  DirectoryFieldIssue,
  DirectoryFieldIssueCode,
  DirectoryFlow,
  DirectoryFlowField,
} from "./types.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The portal's helper: "Lowercase letters, numbers, and hyphens." */
const SLUG = /^[a-z0-9-]+$/;
/** A project secret's name as the platform stores it: an environment variable's. */
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** The ChatGPT portal's words for a field its package manages. */
const PACKAGE_READ_ONLY =
  "Package details are read-only here; edit them in your source package.";

/** MCPJam's wording where the portal's error line was not captured. */
const FORMAT_HINTS: Record<DirectoryFieldFormat, string> = {
  "https-url": "Enter a full https:// URL.",
  url: "Enter a full URL, such as https://example.com.",
  email: "Enter an email address.",
  "url-or-email": "Enter a URL or an email address.",
  slug: "Use only lowercase letters, numbers, and hyphens.",
};

const KINDS: Record<DirectoryFlowField["control"], string> = {
  text: "text",
  textarea: "text",
  select: "one option value",
  "multi-select": "a list of option values",
  radio: "one option value",
  "radio-cards": "one option value",
  checkbox: "true or false",
  "checkbox-group": "a list of option values",
  pairs: "a list of rows",
  rows: "a list of records",
  server: "a server URL",
  secret:
    "the name of a project secret, such as REVIEWER_PASSWORD, never the secret itself",
};

/** A value of the wrong kind for its control, as opposed to a badly formed one. */
type Problem = Exclude<DirectoryFieldIssueCode, "unknownField"> | "wrongKind";

interface ValidateOptions {
  on?: "form" | "review";
  /**
   * Names of the project's secrets that hold a value. A secret field naming
   * another reports `secretUnset`; without the list nobody looked, so none does.
   */
  savedSecrets?: readonly string[];
}

/**
 * `origin: "imported"` is a package import writing what the package holds:
 * only it may set a package-managed field, and only a value of the wrong kind
 * is refused, because the review reports a package's limits.
 */
export function validateDirectoryAnswerInput(
  flow: DirectoryFlow,
  key: string,
  value: DirectoryAnswerValue,
  options: { origin?: DirectoryAnswerOrigin } = {}
): DirectoryFieldIssue | undefined {
  const field = directoryFlowField(flow, key);
  if (!field) return unknownField(key);
  let problem = shapeProblem(field, value);
  if (field.managedBy === "package") {
    if (options.origin !== "imported") {
      problem = isBlankAnswer(field, value) ? undefined : "managedByPackage";
    } else if (problem !== "wrongKind") {
      problem = undefined;
    }
  }
  return problem && issue(flow, field, problem, value);
}

/**
 * Every issue the portal would raise, at most one per field, in form order.
 * `on: "review"` adds what only the review page asks for. Pass the stored
 * answers: the flow's defaults are merged in here.
 */
export function validateDirectoryAnswers(
  flow: DirectoryFlow,
  answers: readonly DirectoryAnswer[],
  options: ValidateOptions = {}
): DirectoryFieldIssue[] {
  const merged = withDirectoryFlowDefaults(flow, answers);
  const byKey = new Map(merged.map((answer) => [answer.key, answer]));
  const issues: DirectoryFieldIssue[] = [];
  for (const step of flow.steps) {
    for (const field of step.fields) {
      const answer = byKey.get(field.key);
      const problem = fieldProblem(flow, field, answer, byKey, options);
      if (problem) issues.push(issue(flow, field, problem, answer?.value));
    }
  }
  for (const key of byKey.keys()) {
    if (!directoryFlowField(flow, key)) issues.push(unknownField(key));
  }
  return issues;
}

function fieldProblem(
  flow: DirectoryFlow,
  field: DirectoryFlowField,
  answer: DirectoryAnswer | undefined,
  byKey: ReadonlyMap<string, DirectoryAnswer>,
  { on = "form", savedSecrets }: ValidateOptions
): Problem | undefined {
  const value = answer?.value ?? null;
  const shape = shapeProblem(field, value);
  if (shape) return shape;
  if (isBlankAnswer(field, value)) {
    const asked =
      (field.required && (on === "review" || field.requiredOn !== "review")) ||
      answeredAny(flow, field.requiredWith, byKey);
    return asked && !standsIn(field, byKey) ? "required" : undefined;
  }
  if (typeof value === "string") {
    if (field.format && !matchesFormat(field.format, value)) return "format";
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return "tooLong";
    }
    // Named but empty: the portal reads the section complete with no password.
    if (field.control === "secret" && savedSecrets?.includes(value) === false) {
      return "secretUnset";
    }
  }
  if (Array.isArray(value)) {
    const count = isStringList(value) ? new Set(value).size : value.length;
    if (count < (field.minItems ?? 0)) return "tooFew";
    // A package holds as many as it holds; the write took them all.
    if (field.control === "rows" && count > (field.maxItems ?? Infinity)) {
      return "tooMany";
    }
  }
  if (
    field.declaration &&
    answer?.origin === "confirmed" &&
    answer.wordingRevision !== directoryFieldWordingRevision(flow, field.key)
  ) {
    return "wordingChanged";
  }
  return undefined;
}

/** What the portal's control itself could never hold. Blank values pass. */
function shapeProblem(
  field: DirectoryFlowField,
  value: DirectoryAnswerValue
): Problem | undefined {
  if (value === null || value === "") return undefined;
  switch (field.control) {
    case "checkbox":
      return typeof value === "boolean" ? undefined : "wrongKind";
    case "multi-select":
    case "checkbox-group":
      if (!isStringList(value)) return "wrongKind";
      if (value.some((entry) => !offers(field, entry))) return "unknownOption";
      // Distinct choices: ticking one box twice is still one box.
      return new Set(value).size > (field.maxItems ?? Infinity)
        ? "tooMany"
        : undefined;
    case "pairs":
      if (!isRowList(value, field.pairs?.keys ?? [])) return "wrongKind";
      return value.length > (field.pairs?.maxRows ?? Infinity)
        ? "tooMany"
        : undefined;
    case "rows":
      return isRowList(value) ? undefined : "wrongKind";
    case "secret":
      return typeof value === "string" && SECRET_NAME.test(value)
        ? undefined
        : "wrongKind";
    case "select":
    case "radio":
    case "radio-cards":
      if (typeof value !== "string") return "wrongKind";
      return offers(field, value) ? undefined : "unknownOption";
    default:
      return typeof value === "string" ? undefined : "wrongKind";
  }
}

/** A free-entry field takes any value; any other only the options it lists. */
function offers(field: DirectoryFlowField, value: string): boolean {
  return (
    field.freeEntry === true ||
    (field.options ?? []).some((entry) => entry.value === value)
  );
}

/** Whether any of `keys` has an answer, which asks for a field `requiredWith` them. */
function answeredAny(
  flow: DirectoryFlow,
  keys: readonly string[] | undefined,
  byKey: ReadonlyMap<string, DirectoryAnswer>
): boolean {
  return (keys ?? []).some((key) => {
    const other = directoryFlowField(flow, key);
    return Boolean(other && !isBlankAnswer(other, byKey.get(key)?.value));
  });
}

function standsIn(
  field: DirectoryFlowField,
  byKey: ReadonlyMap<string, DirectoryAnswer>
): boolean {
  return Boolean(
    field.satisfiedBy?.length &&
    field.satisfiedBy.every(({ key, format }) => {
      const value = byKey.get(key)?.value;
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        (!format || matchesFormat(format, value))
      );
    })
  );
}

function matchesFormat(format: DirectoryFieldFormat, value: string): boolean {
  switch (format) {
    case "https-url":
      return protocolOf(value) === "https:";
    case "url":
      return ["https:", "http:"].includes(protocolOf(value) ?? "");
    case "email":
      return EMAIL.test(value.trim());
    case "url-or-email":
      return matchesFormat("email", value) || matchesFormat("url", value);
    case "slug":
      return SLUG.test(value);
  }
}

function protocolOf(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.hostname ? url.protocol : undefined;
  } catch {
    // Not a URL at all; the caller reports a format problem.
    return undefined;
  }
}

function isStringList(value: DirectoryAnswerValue): value is string[] {
  return (
    Array.isArray(value) &&
    (value as readonly unknown[]).every((entry) => typeof entry === "string")
  );
}

/** Records of strings, with only `columns` when they are given. */
function isRowList(
  value: DirectoryAnswerValue,
  columns?: readonly string[]
): value is Array<Record<string, string>> {
  return (
    Array.isArray(value) &&
    (value as readonly unknown[]).every(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        !Array.isArray(row) &&
        Object.entries(row).every(
          ([column, cell]) =>
            (!columns || columns.includes(column)) && typeof cell === "string"
        )
    )
  );
}

function issue(
  flow: DirectoryFlow,
  field: DirectoryFlowField,
  problem: Problem,
  value: DirectoryAnswerValue | undefined
): DirectoryFieldIssue {
  const step = flow.steps.find((entry) => entry.fields.includes(field));
  return {
    key: field.key,
    step: step?.id ?? "",
    code: problem === "wrongKind" ? "format" : problem,
    message: messageFor(flow, field, problem, value),
  };
}

function messageFor(
  flow: DirectoryFlow,
  field: DirectoryFlowField,
  problem: Problem,
  value: DirectoryAnswerValue | undefined
): string {
  const label = field.label.toLowerCase();
  switch (problem) {
    case "wrongKind":
      return `${field.label} takes ${KINDS[field.control]}.`;
    case "unknownOption":
      return `Choose one of: ${(field.options ?? []).map((entry) => entry.value).join(", ")}.`;
    case "wordingChanged":
      return "The wording changed after this was confirmed. Read it again and confirm it.";
    case "managedByPackage":
      return PACKAGE_READ_ONLY;
    // The name only: a secret's value never reaches an answer or a message.
    case "secretUnset":
      return `No value is saved for the project secret ${String(value)}. Save the ${label} under that name.`;
  }
  const portal = field.errors[problem];
  if (portal) return portal;
  const count = Array.isArray(value) ? value.length : 0;
  const tickAll =
    field.control === "checkbox-group" &&
    field.minItems === field.options?.length;
  const trigger = field.required
    ? undefined
    : field.requiredWith?.map((key) => directoryFlowField(flow, key)?.label)[0];
  switch (problem) {
    case "required":
      if (tickAll) return `Tick all ${field.minItems} ${label} to submit.`;
      if (field.control === "rows" && field.minItems) {
        return `Supply ${field.minItems} ${label}.`;
      }
      return trigger
        ? `Add ${label} for the ${trigger.toLowerCase()} you entered.`
        : `${field.label} is required.`;
    case "format":
      return FORMAT_HINTS[field.format ?? "url"];
    case "tooLong":
      return `Use ${field.maxLength} characters or fewer. This has ${String(value).length}.`;
    case "tooMany":
      return field.control === "rows"
        ? `Supply at most ${field.maxItems} ${label}. There are ${count}.`
        : `Choose up to ${field.maxItems ?? field.pairs?.maxRows}.`;
    case "tooFew":
      if (tickAll) return `Tick all ${field.minItems} ${label} to submit.`;
      return field.control === "rows"
        ? `Supply at least ${field.minItems} ${label}. There are ${count}.`
        : `Choose at least ${field.minItems}.`;
  }
}

function unknownField(key: string): DirectoryFieldIssue {
  return {
    key,
    step: key.split(".")[0] ?? "",
    code: "unknownField",
    message: `This flow has no field ${key}. Read the flow for its field keys.`,
  };
}
