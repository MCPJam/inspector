/**
 * Pure (React-free) parsing / validation / serialization helpers for MCP
 * elicitation request schemas.
 *
 * Scope: the MCP 2025-11-25 elicitation subset — a FLAT object schema whose
 * properties are primitives, single-select enums, or arrays of enums. Anything
 * outside that subset (nested objects, arrays of objects, unrecognized types)
 * is spec-forbidden; rather than dropping it we surface it as a `json` field so
 * the user can still answer by hand.
 *
 * Everything here is deliberately free of React and DOM APIs so it can be unit
 * tested directly and reused by other elicitation surfaces (form dialog today,
 * hosted/chat dialogs later).
 */

export type ElicitationFieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "multi-enum"
  | "json";

export type ElicitationFieldFormat = "email" | "uri" | "date" | "date-time";

export interface ElicitationFieldOption {
  /** The value sent back to the server. */
  value: string;
  /** Human-readable label; falls back to `value` when the schema has no title. */
  label: string;
}

export interface ElicitationField {
  /** Raw property key from the schema — this is what the server keys on. */
  name: string;
  kind: ElicitationFieldKind;
  /** Schema `title`, when present. Display-only; never replaces `name`. */
  title?: string;
  description?: string;
  required: boolean;
  /** Schema `default`, when present. Used to prefill the form. */
  default?: unknown;
  format?: ElicitationFieldFormat;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Present for `enum` and `multi-enum`. */
  options?: ElicitationFieldOption[];
  /** `multi-enum` only. */
  minItems?: number;
  /** `multi-enum` only. */
  maxItems?: number;
}

/** A value that fits the MCP `ElicitResult.content` shape. */
export type ElicitationContentValue = string | number | boolean | string[];

const FORMATS: readonly ElicitationFieldFormat[] = [
  "email",
  "uri",
  "date",
  "date-time",
];

/**
 * `pattern` is chosen by the MCP server, and `RegExp.test` runs unbounded on
 * the UI thread with a backtracking engine. A hostile (or merely careless)
 * server can send a catastrophic pattern — `(a+)+$` already costs ~160ms
 * against 24 characters and doubles per extra char — which would freeze the tab
 * as the user types.
 *
 * Without a safe (RE2-style) engine available, this refuses to run patterns
 * carrying the shape that makes backtracking explode: a quantifier applied to a
 * group that itself contains a quantifier or an alternation, e.g. `(a+)+`,
 * `(a*)*`, `(a|aa)+`. Skipping validation is the safe failure — the MCP server
 * re-validates its own schema, so the worst case is that a bad value round-trips
 * instead of being caught early. Freezing the renderer is not a safe failure.
 *
 * Bounded input alone wouldn't save us: maxLength is also server-supplied.
 */
const NESTED_QUANTIFIER_RE = /\([^()]*[+*{|][^()]*\)\s*[+*]|\([^()]*\)\s*\{\d+,\s*\}/;

export function isSafeUserFacingPattern(pattern: string): boolean {
  // Long patterns are themselves a smell and cost more to analyze than to skip.
  if (pattern.length > 300) return false;
  return !NESTED_QUANTIFIER_RE.test(pattern);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Tolerates the `datetime-local` input's timezone-less value as well as full
// RFC 3339 strings.
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asFormat(value: unknown): ElicitationFieldFormat | undefined {
  return typeof value === "string" &&
    (FORMATS as readonly string[]).includes(value)
    ? (value as ElicitationFieldFormat)
    : undefined;
}

/**
 * Options from a `{ enum: [...] , enumNames?: [...] }` pair.
 * `enumNames` is the legacy (pre-2025-11-25) label channel; still emitted by
 * plenty of servers, so we honor it.
 */
function optionsFromEnum(prop: Record<string, unknown>) {
  const values = prop.enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (!values.every((v): v is string => typeof v === "string"))
    return undefined;
  const names = Array.isArray(prop.enumNames) ? prop.enumNames : undefined;
  return values.map((value, i) => ({
    value,
    label: asString(names?.[i]) ?? value,
  }));
}

/**
 * Options from `oneOf`/`anyOf: [{ const, title? }, ...]` — the 2025-11-25 way
 * of attaching labels to enum members.
 */
function optionsFromConstBranches(branches: unknown) {
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const options: ElicitationFieldOption[] = [];
  for (const branch of branches) {
    if (!isRecord(branch)) return undefined;
    const value = asString(branch.const);
    if (value === undefined) return undefined;
    options.push({ value, label: asString(branch.title) ?? value });
  }
  return options;
}

/**
 * True when a property *declares* a choice constraint, however malformed.
 * We must not silently degrade `{type:"string", enum:["a",2]}` to a free-text
 * input — that would drop the server's constraint. Declared-but-unparseable
 * goes to the `json` fallback instead.
 */
function declaresChoice(prop: Record<string, unknown>): boolean {
  return "enum" in prop || "oneOf" in prop || "anyOf" in prop;
}

function singleSelectOptions(prop: Record<string, unknown>) {
  return (
    optionsFromEnum(prop) ??
    optionsFromConstBranches(prop.oneOf) ??
    optionsFromConstBranches(prop.anyOf)
  );
}

function multiSelectOptions(prop: Record<string, unknown>) {
  const items = prop.items;
  if (!isRecord(items)) return undefined;
  return (
    optionsFromEnum(items) ??
    optionsFromConstBranches(items.anyOf) ??
    optionsFromConstBranches(items.oneOf)
  );
}

function jsonField(
  name: string,
  prop: Record<string, unknown> | undefined,
  required: boolean
): ElicitationField {
  return {
    name,
    kind: "json",
    title: asString(prop?.title),
    description: asString(prop?.description),
    required,
    ...(prop && "default" in prop ? { default: prop.default } : {}),
  };
}

/**
 * Parse an elicitation `requestedSchema` into a flat field list.
 * Non-conforming input yields `[]` (nothing to render) or `json` fields.
 */
export function parseElicitationSchema(schema: unknown): ElicitationField[] {
  if (!isRecord(schema)) return [];
  const properties = schema.properties;
  if (!isRecord(properties)) return [];

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : []
  );

  const fields: ElicitationField[] = [];
  for (const [name, rawProp] of Object.entries(properties)) {
    const isRequired = required.has(name);
    if (!isRecord(rawProp)) {
      fields.push(jsonField(name, undefined, isRequired));
      continue;
    }
    fields.push(parseProperty(name, rawProp, isRequired));
  }
  return fields;
}

function parseProperty(
  name: string,
  prop: Record<string, unknown>,
  required: boolean
): ElicitationField {
  const base = {
    name,
    title: asString(prop.title),
    description: asString(prop.description),
    required,
    ...("default" in prop ? { default: prop.default } : {}),
  };

  const type = asString(prop.type);

  // Arrays are only supported as multi-select enums (spec subset).
  if (type === "array") {
    const options = multiSelectOptions(prop);
    if (!options) return jsonField(name, prop, required);
    return {
      ...base,
      kind: "multi-enum",
      options,
      minItems: asNumber(prop.minItems),
      maxItems: asNumber(prop.maxItems),
    };
  }

  // Single-select enum. Checked before primitives because an enum property is
  // typically also `type: "string"`.
  if (declaresChoice(prop)) {
    const options = singleSelectOptions(prop);
    return options
      ? { ...base, kind: "enum", options }
      : jsonField(name, prop, required);
  }

  switch (type) {
    case "string":
      return {
        ...base,
        kind: "string",
        format: asFormat(prop.format),
        minLength: asNumber(prop.minLength),
        maxLength: asNumber(prop.maxLength),
        pattern: asString(prop.pattern),
      };
    case "number":
    case "integer":
      return {
        ...base,
        kind: type,
        minimum: asNumber(prop.minimum),
        maximum: asNumber(prop.maximum),
      };
    case "boolean":
      return { ...base, kind: "boolean" };
    default:
      // Nested objects, untyped props, anything else the spec forbids here.
      return jsonField(name, prop, required);
  }
}

export function fieldLabel(field: ElicitationField): string {
  return field.title ?? field.name;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Validate a single field's current form value.
 * @returns an error message to render under the field, or `null` when valid.
 */
export function validateField(
  field: ElicitationField,
  value: unknown
): string | null {
  const label = fieldLabel(field);

  if (field.kind === "multi-enum") {
    const selected = toStringArray(value);
    if (field.required && selected.length === 0) {
      return `${label} is required`;
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
      const n = Number(value);
      if (!Number.isFinite(n)) return `${label} must be a number`;
      if (field.kind === "integer" && !Number.isInteger(n)) {
        return `${label} must be an integer`;
      }
      if (field.minimum !== undefined && n < field.minimum) {
        return `${label} must be at least ${field.minimum}`;
      }
      if (field.maximum !== undefined && n > field.maximum) {
        return `${label} must be at most ${field.maximum}`;
      }
      return null;
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
  field: ElicitationField,
  str: string,
  label: string
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
  if (field.pattern !== undefined && isSafeUserFacingPattern(field.pattern)) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(field.pattern);
    } catch {
      // A malformed server-supplied pattern must not break the form; skip it.
      re = undefined;
    }
    if (re && !re.test(str)) {
      return `${label} does not match the required format`;
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

function fitsContentShape(value: unknown): value is ElicitationContentValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((v) => typeof v === "string"))
  );
}

/**
 * Coerce raw form values into an MCP `ElicitResult.content` payload.
 * Empty optional fields are omitted entirely; values are narrowed to the
 * `string | number | boolean | string[]` shape the spec allows (a `json`
 * fallback field that parses to something richer is re-serialized to a
 * compact JSON string, mirroring how consumers normalize today).
 */
export function buildElicitationContent(
  fields: ElicitationField[],
  values: Record<string, unknown>
): Record<string, ElicitationContentValue> {
  // Null-prototype: field names come from the server, and a field literally
  // named `__proto__` would otherwise mutate this object's prototype instead of
  // creating a key — the answer would silently never reach the server.
  const content: Record<string, ElicitationContentValue> = Object.create(
    null
  ) as Record<string, ElicitationContentValue>;

  for (const field of fields) {
    const value = values[field.name];

    switch (field.kind) {
      case "boolean":
        content[field.name] = Boolean(value);
        break;

      case "multi-enum": {
        const selected = toStringArray(value);
        if (selected.length > 0) content[field.name] = selected;
        break;
      }

      case "number":
      case "integer": {
        if (isBlank(value)) break;
        const n = Number(value);
        if (Number.isFinite(n)) content[field.name] = n;
        break;
      }

      case "json": {
        if (isBlank(value)) break;
        const raw = String(value);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          content[field.name] = raw;
          break;
        }
        content[field.name] = fitsContentShape(parsed)
          ? parsed
          : JSON.stringify(parsed);
        break;
      }

      case "enum":
      case "string":
      default: {
        if (isBlank(value)) break;
        content[field.name] = String(value);
        break;
      }
    }
  }

  return content;
}

/** Initial form state for a parsed field list, honoring schema `default`s. */
export function initialFormValues(
  fields: ElicitationField[]
): Record<string, unknown> {
  // Null-prototype for the same reason as buildElicitationContent: a server can
  // name a field `__proto__`, and a plain object would swallow it.
  const values: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const field of fields) {
    values[field.name] = defaultValueFor(field);
  }
  return values;
}

function defaultValueFor(field: ElicitationField): unknown {
  const hasDefault = field.default !== undefined;

  switch (field.kind) {
    case "boolean":
      return hasDefault ? Boolean(field.default) : false;
    case "multi-enum": {
      const allowed = new Set(field.options?.map((o) => o.value) ?? []);
      return toStringArray(field.default).filter((v) => allowed.has(v));
    }
    case "enum": {
      const str = hasDefault ? String(field.default) : "";
      return field.options?.some((o) => o.value === str) ? str : "";
    }
    case "json":
      if (!hasDefault) return "";
      return typeof field.default === "string"
        ? field.default
        : JSON.stringify(field.default, null, 2);
    case "number":
    case "integer":
      return hasDefault ? String(field.default) : "";
    case "string":
    default:
      return hasDefault ? String(field.default) : "";
  }
}
