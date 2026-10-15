import { RE2JS } from "re2js";
import { fieldLabel, type SchemaFormField } from "./field";
import { validateNumericConstraints } from "./numeric-validation";

/** Value checks shared by field controls; controllers own schema admission and effects. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Tolerates the `datetime-local` input's timezone-less value as well as full
// RFC 3339 strings.
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Editor validation; controllers separately admit schemas and typed payloads. */
export function validateSchemaFormField(
  field: SchemaFormField,
  value: unknown,
): string | null {
  const label = fieldLabel(field);

  if (field.kind === "multi-enum") {
    const selected = toStringArray(value);
    if (field.required && selected.length === 0) {
      return `${label} is required`;
    }
    // An empty optional editor is a non-answer; the owning controller decides
    // whether to omit it or reject it under its protocol's typed value rules.
    if (!field.required && selected.length === 0) {
      return null;
    }
    if (field.minItems !== undefined && selected.length < field.minItems) {
      return `Select at least ${field.minItems} option${
        field.minItems === 1 ? "" : "s"
      }`;
    }
    if (field.maxItems !== undefined && selected.length > field.maxItems) {
      return `Select at most ${field.maxItems} option${
        field.maxItems === 1 ? "" : "s"
      }`;
    }
    return null;
  }

  // A checkbox always carries a definite answer; `false` satisfies `required`.
  if (field.kind === "boolean") return null;

  if (isBlank(value)) {
    return field.required ? `${label} is required` : null;
  }

  switch (field.kind) {
    case "number":
    case "integer": {
      return validateNumericConstraints(Number(value), field, label);
    }
    case "enum": {
      const str = String(value);
      if (field.options && !field.options.some((o) => o.value === str)) {
        return `${label} must be one of the offered options`;
      }
      return null;
    }
    case "json": {
      try {
        JSON.parse(String(value));
        return null;
      } catch {
        return `${label} must be valid JSON`;
      }
    }
    case "string":
    default:
      return validateString(field, String(value), label);
  }
}

function validateString(
  field: SchemaFormField,
  str: string,
  label: string,
): string | null {
  if (field.minLength !== undefined && str.length < field.minLength) {
    return `${label} must be at least ${field.minLength} character${
      field.minLength === 1 ? "" : "s"
    }`;
  }
  if (field.maxLength !== undefined && str.length > field.maxLength) {
    return `${label} must be at most ${field.maxLength} character${
      field.maxLength === 1 ? "" : "s"
    }`;
  }
  if (field.pattern) {
    try {
      // RE2JS uses a non-backtracking DFA, so server-controlled patterns cannot
      // freeze the renderer. `test` intentionally mirrors RegExp.test's
      // unanchored semantics; schemas that need a full match include ^...$.
      if (!RE2JS.compile(field.pattern).test(str)) {
        return `${label} does not match the required pattern`;
      }
    } catch {
      // RE2 deliberately rejects backreferences/lookarounds and malformed
      // syntax. Do not silently accept content we could not validate.
      return `${label} uses a pattern this client cannot safely validate`;
    }
  }
  switch (field.format) {
    case "email":
      return EMAIL_RE.test(str)
        ? null
        : `${label} must be a valid email address`;
    case "uri":
      return isValidUri(str) ? null : `${label} must be a valid URI`;
    case "date":
      return DATE_RE.test(str) ? null : `${label} must be a valid date`;
    case "date-time":
      return DATE_TIME_RE.test(str)
        ? null
        : `${label} must be a valid date and time`;
    default:
      return null;
  }
}

function isValidUri(str: string): boolean {
  try {
    // Parsing only — never fetched, never rendered as a link.
    new URL(str);
    return true;
  } catch {
    return false;
  }
}
