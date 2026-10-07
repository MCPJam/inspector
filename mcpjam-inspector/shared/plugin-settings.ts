import { z } from "zod";
import { RE2JS } from "re2js";
import {
  OPENAI_SETTINGS_CAPABILITY_KEY,
  OpenAISettingsCapabilitySchema,
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
  OpenAISettingsUpdateArgumentsSchema,
  type OpenAISettingsGroup,
} from "@openai/mcp-extensions/server";
import { validateNumericConstraints } from "./schema-form-numeric.js";

export class PluginSettingsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PluginSettingsError";
  }
}
/** An authenticated RPC refusal can distinguish zero dispatch from lost acknowledgement. */
export class PluginSettingsRequestError extends PluginSettingsError {
  constructor(code: string, readonly outcomeUnknown: boolean) {
    super(code);
    this.name = "PluginSettingsRequestError";
  }
}
function invalid(code = "PLUGIN_SETTINGS_INVALID_RESULT"): never {
  throw new PluginSettingsError(code);
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function bounded(input: unknown) {
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return invalid();
  }
  if (size > 512 * 1024) invalid("PLUGIN_SETTINGS_LIMIT");
}

/** Absent and malformed declarations are distinct. Modern discovery has no experimental fallback. */
export function pluginSettingsCapability(
  capabilities: unknown,
  transport: "legacy" | "mrtr",
) {
  if (!record(capabilities)) return undefined;
  const extensions = record(capabilities.extensions)
    ? capabilities.extensions
    : undefined;
  const experimental = record(capabilities.experimental)
    ? capabilities.experimental
    : undefined;
  const primary =
    record(extensions) &&
    Object.hasOwn(extensions, OPENAI_SETTINGS_CAPABILITY_KEY);
  const fallback =
    transport === "legacy" &&
    record(experimental) &&
    Object.hasOwn(experimental, OPENAI_SETTINGS_CAPABILITY_KEY);
  if (!primary && !fallback) return undefined;
  const parse = (value: unknown) => {
    const result = OpenAISettingsCapabilitySchema.safeParse(value);
    if (
      !result.success ||
      result.data.readTool === result.data.updateTool ||
      [result.data.readTool, result.data.updateTool].some(
        (name) => name.length > 256,
      )
    )
      return invalid("PLUGIN_SETTINGS_INVALID_CAPABILITY");
    return result.data;
  };
  const capability = parse(
    primary
      ? extensions?.[OPENAI_SETTINGS_CAPABILITY_KEY]
      : experimental?.[OPENAI_SETTINGS_CAPABILITY_KEY],
  );
  if (primary && fallback) {
    const legacy = parse(experimental?.[OPENAI_SETTINGS_CAPABILITY_KEY]);
    if (
      capability.readTool !== legacy.readTool ||
      capability.updateTool !== legacy.updateTool
    )
      invalid("PLUGIN_SETTINGS_AMBIGUOUS_CAPABILITY");
  }
  return capability;
}

const fieldSchema = z.strictObject({
  type: z.enum(["string", "boolean", "number", "integer"]),
  title: z.string().trim().min(1).max(4096),
  description: z.string().max(16384).optional(),
  enum: z.array(z.string()).min(1).max(256).optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().max(4096).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  multipleOf: z.number().finite().positive().optional(),
});
export type PluginSettingsField = z.infer<typeof fieldSchema> & {
  name: string;
};
export type PluginSettingsValue = string | number | boolean;
export type PluginSettingsValues = Record<string, PluginSettingsValue>;
export interface PluginSettingsDocument {
  fields: PluginSettingsField[];
  groups: OpenAISettingsGroup[];
  values: PluginSettingsValues;
}

/** JSON payloads are strictly typed; editor strings never coerce server values. */
export function validatePluginSettingValue(
  field: PluginSettingsField,
  value: unknown,
): string | null {
  if (field.type === "boolean")
    return typeof value === "boolean"
      ? null
      : `${field.title} must be a boolean`;
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number") return `${field.title} must be a number`;
    return validateNumericConstraints(
      value,
      { ...field, kind: field.type },
      field.title,
    );
  }
  if (typeof value !== "string") return `${field.title} must be a string`;
  // JSON Schema measures Unicode code points, not UTF-16 code units.
  const length = Array.from(value).length;
  if (field.minLength !== undefined && length < field.minLength)
    return `${field.title} is too short`;
  if (field.maxLength !== undefined && length > field.maxLength)
    return `${field.title} is too long`;
  if (field.enum && !field.enum.includes(value))
    return `${field.title} must be one of the offered options`;
  if (field.pattern !== undefined) {
    try {
      if (!RE2JS.compile(field.pattern).test(value))
        return `${field.title} does not match the required pattern`;
    } catch {
      return `${field.title} uses a pattern this client cannot safely validate`;
    }
  }
  return null;
}

export function parsePluginSettingsValues(
  fields: readonly PluginSettingsField[],
  input: unknown,
): PluginSettingsValues {
  if (!record(input) || Object.keys(input).length !== fields.length) invalid();
  const values: PluginSettingsValues = Object.create(null);
  for (const field of fields) {
    if (
      !Object.hasOwn(input, field.name) ||
      validatePluginSettingValue(field, input[field.name])
    )
      invalid();
    values[field.name] = input[field.name] as PluginSettingsValue;
  }
  return values;
}

/** Official envelopes first, then the host's supported semantics. Reject the whole form. */
export function parsePluginSettingsDocument(
  input: unknown,
): PluginSettingsDocument {
  bounded(input);
  // Zod records deliberately strip __proto__; refuse explicitly before any key can disappear.
  if (
    record(input) &&
    record(input.schema) &&
    record(input.schema.properties) &&
    Object.hasOwn(input.schema.properties, "__proto__")
  )
    invalid("PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA");
  if (
    record(input) &&
    record(input.values) &&
    Object.hasOwn(input.values, "__proto__")
  )
    invalid();
  const result = OpenAISettingsReadResultSchema.safeParse(input);
  if (!result.success) return invalid();
  const { schema, layout, values } = result.data;
  const root = z
    .strictObject({
      $schema: z.string().optional(),
      type: z.literal("object"),
      title: z.string().optional(),
      description: z.string().optional(),
      properties: z.record(z.string(), z.unknown()).default({}),
      required: z.array(z.string()).optional(),
      additionalProperties: z.literal(false).optional(),
    })
    .safeParse(schema);
  if (!root.success) return invalid("PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA");
  const entries = Object.entries(root.data.properties);
  if (entries.length > 128 || (layout?.length ?? 0) > 128)
    invalid("PLUGIN_SETTINGS_LIMIT");
  const names = new Set(entries.map(([name]) => name));
  if (
    root.data.required &&
    (new Set(root.data.required).size !== root.data.required.length ||
      root.data.required.some((name) => !names.has(name)))
  )
    invalid();
  const fields = entries.map(([name, definition]): PluginSettingsField => {
    const parsed = fieldSchema.safeParse(definition);
    if (!parsed.success || name.length > 256)
      return invalid("PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA");
    const field = parsed.data;
    const numeric = ["minimum", "maximum", "multipleOf"].some((key) =>
      Object.hasOwn(field, key),
    );
    const string = ["enum", "minLength", "maxLength", "pattern"].some((key) =>
      Object.hasOwn(field, key),
    );
    if (
      (numeric && field.type !== "number" && field.type !== "integer") ||
      (string && field.type !== "string") ||
      (field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum) ||
      (field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength) ||
      (field.enum && new Set(field.enum).size !== field.enum.length)
    )
      invalid("PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA");
    if (field.pattern !== undefined) {
      try {
        RE2JS.compile(field.pattern);
      } catch {
        return invalid("PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA");
      }
    }
    return { ...field, name };
  });
  const groups = structuredClone(layout ?? []);
  const used = new Set(
    groups.flatMap((group) =>
      group.items.flatMap((item) =>
        item.kind === "property" ? [item.property] : [],
      ),
    ),
  );
  if (groups.reduce((count, group) => count + group.items.length, 0) > 256)
    invalid("PLUGIN_SETTINGS_LIMIT");
  const other = fields.filter(({ name }) => !used.has(name));
  if (other.length)
    groups.push({
      kind: "group",
      title: "Other settings",
      items: other.map(({ name }) => ({ kind: "property", property: name })),
    });
  return { fields, groups, values: parsePluginSettingsValues(fields, values) };
}

export function parsePluginSettingsUpdate(
  fields: readonly PluginSettingsField[],
  input: unknown,
) {
  bounded(input);
  if (
    record(input) &&
    record(input.values) &&
    Object.hasOwn(input.values, "__proto__")
  )
    invalid();
  const result = OpenAISettingsUpdateResultSchema.safeParse(input);
  if (!result.success) return invalid();
  return parsePluginSettingsValues(fields, result.data.values);
}

/** Reuse at the trusted execution boundary; a server's helper may validate more permissively. */
export function parsePluginSettingsSet(
  fields: readonly PluginSettingsField[],
  input: unknown,
) {
  bounded(input);
  if (
    record(input) &&
    record(input.set) &&
    Object.hasOwn(input.set, "__proto__")
  )
    invalid("PLUGIN_SETTINGS_INVALID_EDIT");
  const result = OpenAISettingsUpdateArgumentsSchema.safeParse(input);
  if (!result.success) return invalid("PLUGIN_SETTINGS_INVALID_EDIT");
  const set: PluginSettingsValues = Object.create(null);
  for (const [name, value] of Object.entries(result.data.set)) {
    const field = fields.find((field) => field.name === name);
    if (!field || validatePluginSettingValue(field, value))
      invalid("PLUGIN_SETTINGS_INVALID_EDIT");
    set[name] = value as PluginSettingsValue;
  }
  return { set };
}
