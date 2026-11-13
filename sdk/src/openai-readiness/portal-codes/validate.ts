/**
 * The generic validators the code table drives: a code whose target names a
 * field and rules is checked in the document its table describes, by the
 * rule's kind.
 *
 * A field's presence, type and emptiness problems stop the rest of its checks,
 * and those of everything under it: the page lists them first for each field,
 * and a missing field has no length to report.
 *
 * Pure. Safe from the browser entry.
 */

import { findUnsupportedCharacters } from "../package/supported-text.js";
import type {
  OpenAIPortalCodeStage,
  OpenAIPortalDocument,
  OpenAIPortalRule,
} from "./define.js";
import {
  OPENAI_PORTAL_CODES,
  type OpenAIPortalCode,
  type OpenAIPortalCodeDefinition,
} from "./table.js";

export interface OpenAIPortalCodeViolation {
  code: OpenAIPortalCode;
  /** The field as found, e.g. `interface.capabilities[2]` or `apps.notes.id`. */
  field: string;
  observed?: string | number;
  expected?: string | number;
}

export interface ValidateOpenAIPortalDocumentOptions {
  /**
   * `upload` (the default) checks what the ZIP upload checks. `submission`
   * checks what "Submit for review" adds to a package that passed upload: the
   * final codes, and the stricter limits the page gives upload codes there.
   */
  stage?: OpenAIPortalCodeStage;
}

type Failure = Pick<OpenAIPortalCodeViolation, "observed" | "expected">;

interface Found {
  path: string;
  value: unknown;
}

const STOPS: ReadonlySet<OpenAIPortalRule["kind"]> = new Set([
  "present",
  "type",
  "nonEmpty",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/**
 * The values `field` names. `*` is each value of an object; `[]` each entry of
 * a list, where a lone value counts as a list of one.
 */
function locate(document: unknown, field: string): Found[] {
  let found: Found[] = [{ path: "", value: document }];
  for (const segment of field.split(".")) {
    found = found.flatMap(({ path, value }): Found[] => {
      if (segment === "*") {
        return isRecord(value)
          ? Object.entries(value).map(([key, child]) => ({
              path: join(path, key),
              value: child,
            }))
          : [];
      }
      const list = segment.endsWith("[]");
      const key = list ? segment.slice(0, -2) : segment;
      const at = join(path, key);
      const child =
        isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
      if (!list) return [{ path: at, value: child }];
      if (Array.isArray(child)) {
        return child.map((entry, index) => ({
          path: `${at}[${index}]`,
          value: entry,
        }));
      }
      return child === undefined ? [] : [{ path: at, value: child }];
    });
  }
  return found;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function textFailure(value: string, singleLine?: true): Failure | undefined {
  const [unsupported] = findUnsupportedCharacters(value);
  if (unsupported) return { observed: unsupported.codePoint };
  return singleLine && /[\r\n]/.test(value)
    ? { observed: "a line break" }
    : undefined;
}

/** How `value` breaks `rule`, or `undefined` when it does not. */
function failure(
  rule: OpenAIPortalRule,
  value: unknown,
  stage: OpenAIPortalCodeStage
): Failure | undefined {
  switch (rule.kind) {
    case "present":
      return value === undefined ? {} : undefined;
    case "type": {
      const actual = typeName(value);
      return value === undefined || rule.types.some((type) => type === actual)
        ? undefined
        : { observed: actual, expected: rule.types.join(" or ") };
    }
    case "nonEmpty":
      if (value === undefined) return rule.required ? {} : undefined;
      // The page: "Non-empty values can't contain only whitespace."
      return typeof value === "string" && value.trim() === "" ? {} : undefined;
    case "length": {
      if (typeof value !== "string") return undefined;
      const max =
        stage === "submission" ? (rule.submissionMax ?? rule.max) : rule.max;
      const length = [...value].length;
      return length > max ? { observed: length, expected: max } : undefined;
    }
    case "pattern":
      return typeof value === "string" &&
        rule.pattern.test(value) === Boolean(rule.forbidden)
        ? { observed: value }
        : undefined;
    case "enum":
      return typeof value === "string" && !rule.values.includes(value)
        ? { observed: value }
        : undefined;
    case "count":
      return Array.isArray(value) && value.length > rule.max
        ? { observed: value.length, expected: rule.max }
        : undefined;
    case "text":
      return typeof value === "string"
        ? textFailure(value, rule.singleLine)
        : undefined;
  }
}

/** Upload codes run at submission only for a stricter limit given there. */
function checkedAt(
  definition: OpenAIPortalCodeDefinition,
  stage: OpenAIPortalCodeStage
): boolean {
  if (definition.stage === stage) return true;
  return (
    stage === "submission" &&
    (definition.rules ?? []).some(
      (rule) => rule.kind === "length" && rule.submissionMax !== undefined
    )
  );
}

/**
 * The portal codes `value`, read as `document`, breaks: one per code and field,
 * in the page's order.
 */
export function validateOpenAIPortalDocument(
  document: OpenAIPortalDocument,
  value: unknown,
  { stage = "upload" }: ValidateOpenAIPortalDocumentOptions = {}
): OpenAIPortalCodeViolation[] {
  const violations: OpenAIPortalCodeViolation[] = [];
  const stopped: string[] = [];
  const isStopped = (path: string) =>
    stopped.some(
      (stop) =>
        path === stop ||
        path.startsWith(`${stop}.`) ||
        path.startsWith(`${stop}[`)
    );

  for (const definition of OPENAI_PORTAL_CODES) {
    const { field, rules } = definition;
    if (definition.document !== document || !field || !rules) continue;
    if (!checkedAt(definition, stage)) continue;
    for (const found of locate(value, field)) {
      if (isStopped(found.path)) continue;
      for (const rule of rules) {
        const failed = failure(rule, found.value, stage);
        if (!failed) continue;
        violations.push({
          code: definition.code,
          field: found.path,
          ...failed,
        });
        if (STOPS.has(rule.kind)) stopped.push(found.path);
        break;
      }
    }
  }
  return violations;
}
