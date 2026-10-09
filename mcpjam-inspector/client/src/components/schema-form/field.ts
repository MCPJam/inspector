/** Shared controlled-field data, independent of settings/form lifecycles. */
export type SchemaFormFieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "multi-enum"
  | "json";

export type SchemaFormFieldFormat = "email" | "uri" | "date" | "date-time";

export interface SchemaFormFieldOption {
  /** The value sent back to the server. */
  value: string;
  /** Human-readable label; falls back to `value` when the schema has no title. */
  label: string;
}

export interface SchemaFormField {
  /** Raw property key from the schema — this is what the server keys on. */
  name: string;
  kind: SchemaFormFieldKind;
  /** Schema `title`, when present. Display-only; never replaces `name`. */
  title?: string;
  description?: string;
  required: boolean;
  /** Schema `default`, when present. Used to prefill the form. */
  default?: unknown;
  format?: SchemaFormFieldFormat;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Present for `enum` and `multi-enum`. */
  options?: SchemaFormFieldOption[];
  /** `multi-enum` only. */
  minItems?: number;
  /** `multi-enum` only. */
  maxItems?: number;
}

export function fieldLabel(field: SchemaFormField): string {
  return field.title ?? field.name;
}

/** Plain text hint; validation uses the shared RE2 validator. */
export function patternHint(field: SchemaFormField): string | undefined {
  return field.pattern ? `Must match: ${field.pattern}` : undefined;
}
