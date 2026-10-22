/**
 * Which schema an MRTR `elicitation/create` form is shown, answered and
 * validated against.
 *
 * OpenAI's extended forms ride on core MRTR elicitation: the core
 * `requestedSchema` is an empty object (core schemas reject URI arrays and
 * strip extended field metadata) and the real schema travels in
 * `_meta["openai/elicitation"].requestedSchema`. Every reader of a form's
 * schema (display, source binding, submission and retry validation) must make
 * the same choice, so they all call this one pure function.
 */
export const OPENAI_ELICITATION_EXTENSION = "openai/elicitation";

export type ElicitationFormSchemaSelection =
  | { kind: "schema"; source: "core" | "openai/elicitation"; schema: unknown }
  | {
      kind: "unsupported";
      reason: "extension-schema-invalid" | "extension-forms-off";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * - `_meta["openai/elicitation"]` present and extension forms live for this
 *   request: its `requestedSchema`, which must be an object schema.
 * - `_meta["openai/elicitation"]` present but its schema is missing or not an
 *   object schema, or extension forms are not live: unsupported. The empty
 *   core form is never shown in its place.
 * - No `_meta["openai/elicitation"]`: the core `requestedSchema` (a plain MCP
 *   form, possibly an empty confirmation).
 */
export function selectElicitationFormSchema(
  params: Record<string, unknown> | undefined,
  options: { extensionForms: boolean }
): ElicitationFormSchemaSelection {
  const meta = params?._meta;
  if (!isRecord(meta) || !Object.hasOwn(meta, OPENAI_ELICITATION_EXTENSION))
    return { kind: "schema", source: "core", schema: params?.requestedSchema };
  if (!options.extensionForms)
    return { kind: "unsupported", reason: "extension-forms-off" };
  const extension = meta[OPENAI_ELICITATION_EXTENSION];
  const schema = isRecord(extension) ? extension.requestedSchema : undefined;
  if (
    !isRecord(schema) ||
    schema.type !== "object" ||
    !isRecord(schema.properties)
  )
    return { kind: "unsupported", reason: "extension-schema-invalid" };
  return { kind: "schema", source: OPENAI_ELICITATION_EXTENSION, schema };
}
