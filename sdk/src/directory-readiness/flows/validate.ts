/**
 * Answers checked the way the portal checks them, with the portal's words.
 *
 * Two entry points with different jobs. `validateDirectoryAnswerInput` is the
 * gate before a write: it refuses only what the portal's own controls could
 * never hold (an unknown field, a list where text goes, an option it does not
 * offer, more rows than it shows). Everything the portal lets a person type
 * and then complains about — a missing answer, a one-liner over its counter,
 * a link that is not https — is stored, and `validateDirectoryAnswers`
 * reports it, as the portal's form and review page do.
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
  server: "a server URL",
  secret: "a secret name",
};

/** A value of the wrong kind for its control, as opposed to a badly formed one. */
type Problem = Exclude<DirectoryFieldIssueCode, "unknownField"> | "wrongKind";

export function validateDirectoryAnswerInput(
  flow: DirectoryFlow,
  key: string,
  value: DirectoryAnswerValue
): DirectoryFieldIssue | undefined {
  const field = directoryFlowField(flow, key);
  if (!field) return unknownField(key);
  const problem = shapeProblem(field, value);
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
  options: { on?: "form" | "review" } = {}
): DirectoryFieldIssue[] {
  const merged = withDirectoryFlowDefaults(flow, answers);
  const byKey = new Map(merged.map((answer) => [answer.key, answer]));
  const issues: DirectoryFieldIssue[] = [];
  for (const step of flow.steps) {
    for (const field of step.fields) {
      const answer = byKey.get(field.key);
      const problem = fieldProblem(flow, field, answer, byKey, options.on);
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
  on: "form" | "review" = "form"
): Problem | undefined {
  const value = answer?.value ?? null;
  const shape = shapeProblem(field, value);
  if (shape) return shape;
  if (isBlankAnswer(field, value)) {
    const asked =
      field.required && (on === "review" || field.requiredOn !== "review");
    return asked && !standsIn(field, byKey) ? "required" : undefined;
  }
  if (typeof value === "string") {
    if (field.format && !matchesFormat(field.format, value)) return "format";
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return "tooLong";
    }
  }
  if (isStringList(value) && new Set(value).size < (field.minItems ?? 0)) {
    return "tooFew";
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

function isRowList(
  value: DirectoryAnswerValue,
  columns: readonly string[]
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
            columns.includes(column) && typeof cell === "string"
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
    message: messageFor(field, problem, value),
  };
}

function messageFor(
  field: DirectoryFlowField,
  problem: Problem,
  value: DirectoryAnswerValue | undefined
): string {
  switch (problem) {
    case "wrongKind":
      return `${field.label} takes ${KINDS[field.control]}.`;
    case "unknownOption":
      return `Choose one of: ${(field.options ?? []).map((entry) => entry.value).join(", ")}.`;
    case "wordingChanged":
      return "The wording changed after this was confirmed. Read it again and confirm it.";
  }
  const portal = field.errors[problem];
  if (portal) return portal;
  switch (problem) {
    case "required":
      return `${field.label} is required.`;
    case "format":
      return FORMAT_HINTS[field.format ?? "url"];
    case "tooLong":
      return `Use ${field.maxLength} characters or fewer. This has ${String(value).length}.`;
    case "tooMany":
      return `Choose up to ${field.maxItems ?? field.pairs?.maxRows}.`;
    case "tooFew":
      return `Choose at least ${field.minItems}.`;
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
