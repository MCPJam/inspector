import { z } from "zod";
import { RE2JS } from "re2js";
import {
  OpenAIFormSchema,
  createOpenAIFormContentSchema,
  type OpenAIForm,
  type OpenAIFormField,
} from "@openai/mcp-extensions/server";
import { ResourceLinkSchema } from "@modelcontextprotocol/core";
import { PLUGIN_FORM_SCHEMA_MAX_BYTES } from "../plugin-form-payload-limits.js";
import {
  describePluginError,
  pluginDiagnostic,
  PLUGIN_DIAGNOSTICS_MAX,
  type PluginDiagnostic,
} from "../plugin-diagnostics.js";

export class PluginFormError extends Error {
  constructor(
    message: string,
    /** The field the refusal is about, when one is. */
    readonly field?: string,
    /** The schema keyword this client doesn't support, when that's why. */
    readonly keyword?: string,
  ) {
    super(message);
  }
}
/** The private action transports JSON text because legal schema keys may not
 * be Convex object keys. Refuse malformed or oversized bytes before mounting.
 */
export function decodePrivatePluginFormSchema(
  text: unknown,
): Record<string, unknown> {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > PLUGIN_FORM_SCHEMA_MAX_BYTES
  )
    throw new PluginFormError("PLUGIN_FORM_UNAVAILABLE");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PluginFormError("PLUGIN_FORM_UNAVAILABLE");
  }
  if (!record(value)) throw new PluginFormError("PLUGIN_FORM_UNAVAILABLE");
  return value;
}
export const pluginFormPreviewSchema = z.union([
  z.strictObject({
    type: z.literal("mcp_app_tool"),
    name: z
      .string()
      .max(256)
      .refine((name) => !!name.trim()),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  ResourceLinkSchema,
]);
export type PluginFormPreview = z.infer<typeof pluginFormPreviewSchema>;
export type PluginFormProfile = {
  /** The client's File resources extension toggle
   * (`mcpProfile.apps.pluginExtensions`). Forms requested through MCP Apps may
   * offer user uploads only when it is on; absent counts as off. Forms
   * requested by the server do not depend on it. */
  fileResources?: boolean;
  origin: "server" | "mcp-app";
  userResources: boolean;
  /** Partial target adapters must refuse unsupported kinds for the whole form. */
  userResourceKinds?: readonly ("file" | "directory")[];
  previews: boolean;
  /** Host-owned partial service admission; absent means the existing complete port. */
  previewKinds?: readonly PluginFormPreview["type"][];
};

/** Installed product ports. Full extension form capability is still withheld. */
export function ownedPluginFormProfile(
  fileResources: boolean,
  origin: PluginFormProfile["origin"],
  localFiles = false,
): PluginFormProfile {
  return {
    fileResources,
    origin,
    userResources: localFiles,
    userResourceKinds: localFiles ? ["file", "directory"] : [],
    previews: true,
    previewKinds: ["resource_link", "mcp_app_tool"],
  };
}
export type PluginFormPlan = {
  schema: OpenAIForm;
  fields: { name: string; field: OpenAIFormField; required: boolean }[];
  /** Author-facing notes for the Logs panel (dropped previews, spec
   * warnings). Never a reason to refuse the form. */
  diagnostics?: PluginDiagnostic[];
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Annotation-only JSON Schema keywords. They describe a schema; they never
 * constrain a value or add an input, so a form that carries them is not
 * partially displayed when they are left out. Accepted where the official
 * parser drops them: the form itself, a field, and an array field's items
 * (OpenAI's Python reference emits a form `title`, for example).
 */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$comment",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

function annotationOnly(
  path: readonly (string | number)[],
  key: string,
  value: unknown,
  node: Record<string, unknown>,
) {
  const level =
    path.length === 0
      ? "form"
      : path.length === 2 && path[0] === "properties"
        ? "field"
        : path.length === 3 && path[0] === "properties" && path[2] === "items"
          ? "items"
          : undefined;
  if (!level) return false;
  if (ANNOTATION_KEYWORDS.has(key)) return true;
  // Answers are already limited to the declared fields.
  if (level === "form") return key === "additionalProperties" && value === false;
  if (level === "field") return key === "_meta" && record(value);
  // A titled multi-select's items may restate their string type.
  return key === "type" && value === "string" && Array.isArray(node.anyOf);
}

/** Reject constraints the official parser would discard, rather than changing the form. */
function retained(
  raw: unknown,
  parsed: unknown,
  path: (string | number)[] = [],
): void {
  if (path.length > 12) throw new PluginFormError("PLUGIN_FORM_TOO_LARGE");
  const field =
    path[0] === "properties" && typeof path[1] === "string"
      ? path[1]
      : undefined;
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || raw.length !== parsed.length)
      throw new PluginFormError("PLUGIN_FORM_UNSUPPORTED", field);
    raw.forEach((item, index) =>
      retained(item, parsed[index], [...path, index]),
    );
  } else if (record(raw)) {
    if (!record(parsed))
      throw new PluginFormError("PLUGIN_FORM_UNSUPPORTED", field);
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.hasOwn(parsed, key)) {
        if (annotationOnly(path, key, value, raw)) continue;
        throw new PluginFormError(
          "PLUGIN_FORM_UNSUPPORTED",
          field ?? (path.length === 1 && path[0] === "properties" ? key : undefined),
          key.slice(0, 120),
        );
      }
      retained(value, parsed[key], [...path, key]);
    }
  }
}

export function pluginFormResources(field: OpenAIFormField) {
  return "x-openai-input" in field && field["x-openai-input"]
    ? field["x-openai-input"]
    : undefined;
}
export function pluginFormOptions(field: OpenAIFormField) {
  if ("oneOf" in field && Array.isArray(field.oneOf)) return field.oneOf;
  if (
    field.type === "array" &&
    "anyOf" in field.items &&
    Array.isArray(field.items.anyOf)
  )
    return field.items.anyOf;
  return [];
}
/** Plain enum controls share the same declared value order in every host. */
export function pluginFormEnumValues(
  field: OpenAIFormField,
): readonly string[] {
  const string = field.type === "array" ? field.items : field;
  return "enum" in string && Array.isArray(string.enum) ? string.enum : [];
}
export function pluginFormFreeArray(field: OpenAIFormField) {
  return (
    field.type === "array" &&
    !pluginFormResources(field) &&
    !pluginFormOptions(field).length &&
    !pluginFormEnumValues(field).length
  );
}
/** A base64 image data URI (OpenAI's reference check, whole string). */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i;
const thumbnailIconSchema = z.object({
  src: z.string().max(128 * 1024),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/**
 * The image a thumbnail may load: an MCP Icon whose `src` is an HTTPS URL or a
 * base64 image data URI (the spec's MUST), with an image `mimeType` when one is
 * given. Anything else is not loaded; the option shows the fallback image and
 * the form logs a warning. The same rule covers titled options, suggestions
 * and resource options (`_meta["openai/thumbnail"]`).
 */
export function pluginFormThumbnailSource(value: unknown): string | undefined {
  const icon = thumbnailIconSchema.safeParse(value);
  if (!icon.success) return;
  const { src, mimeType } = icon.data;
  if (mimeType !== undefined && !/^image\//i.test(mimeType)) return;
  if (DATA_IMAGE.test(src)) return src;
  if (src.length > 8192) return;
  try {
    const url = new URL(src);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function pluginFormPreview(resource: {
  _meta?: Record<string, unknown>;
}) {
  const meta = resource._meta?.["openai/preview"];
  if (meta === undefined) return;
  if (!record(meta) || !Object.hasOwn(meta, "target"))
    throw new PluginFormError("PLUGIN_FORM_PREVIEW_INVALID");
  return pluginFormPreviewSchema.parse(meta.target);
}

/** More bytes than a form may carry; refused before anything is shown. */
export function pluginFormSchemaTooLarge(raw: unknown) {
  return (
    new TextEncoder().encode(JSON.stringify(raw) ?? "").byteLength >
    PLUGIN_FORM_SCHEMA_MAX_BYTES
  );
}

/** Shared whole-request admission; an absent effect port cannot be advertised away. */
export function compilePluginForm(
  raw: unknown,
  profile: PluginFormProfile,
): PluginFormPlan {
  if (pluginFormSchemaTooLarge(raw))
    throw new PluginFormError("PLUGIN_FORM_TOO_LARGE");
  const parsed = OpenAIFormSchema.parse(raw);
  retained(raw, parsed);
  // The plan owns a copy: a preview this host cannot render is dropped from
  // it (and logged) instead of refusing the whole form.
  const schema = structuredClone(parsed);
  const diagnostics: PluginDiagnostic[] = [];
  const note = (diagnostic: PluginDiagnostic) => {
    if (diagnostics.length < PLUGIN_DIAGNOSTICS_MAX) diagnostics.push(diagnostic);
  };
  const entries = Object.entries(schema.properties);
  if (entries.length > 64) throw new PluginFormError("PLUGIN_FORM_TOO_LARGE");
  if (schema.required?.some((name) => !Object.hasOwn(schema.properties, name)))
    throw new PluginFormError("PLUGIN_FORM_UNSUPPORTED");
  for (const [name, field] of entries) {
    const input = pluginFormResources(field);
    const richOptions = pluginFormOptions(field);
    const options =
      input?.options ??
      (richOptions.length ? richOptions : pluginFormEnumValues(field));
    if (options.length > 128)
      throw new PluginFormError("PLUGIN_FORM_TOO_LARGE", name);
    if (input) {
      const upload =
        input.selection === "implicit" || input.userOptions !== undefined;
      // The spec allows only explicit selection, without user uploads, in
      // forms requested through MCP Apps where File resources is unsupported
      // (its web column). Here that is the client's own toggle.
      if (
        profile.origin === "mcp-app" &&
        profile.fileResources !== true &&
        upload
      )
        throw new PluginFormError("PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED", name);
      if (upload && !profile.userResources)
        throw new PluginFormError("PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE", name);
      if (
        upload &&
        profile.userResourceKinds &&
        !profile.userResourceKinds.includes(input.userOptions?.kind ?? "file")
      )
        throw new PluginFormError("PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE", name);
      for (const resource of input.options) {
        // A preview is not an input: one this host cannot render (or that is
        // malformed) loses its Preview action, never the whole form.
        let preview: PluginFormPreview | undefined;
        let invalid = false;
        try {
          preview = pluginFormPreview(resource);
        } catch {
          invalid = true;
        }
        const unsupported =
          !!preview &&
          (!profile.previews ||
            (!!profile.previewKinds &&
              !profile.previewKinds.includes(preview.type)));
        if (!invalid && !unsupported) continue;
        const meta = { ...(resource._meta ?? {}) };
        delete meta["openai/preview"];
        if (Object.keys(meta).length) resource._meta = meta;
        else delete resource._meta;
        note(
          pluginDiagnostic(
            "warning",
            invalid ? "PLUGIN_FORM_PREVIEW_INVALID" : "PLUGIN_FORM_PREVIEW_DROPPED",
            invalid
              ? `Form field "${name}": preview ignored (malformed)`
              : `Form field "${name}": preview not shown`,
            invalid
              ? `The option "${resource.name}" declares _meta["openai/preview"] without a valid target, so its Preview action is hidden. The rest of the form works.`
              : `This client can't render a "${preview!.type}" preview, so the option "${resource.name}" has no Preview action. The rest of the form works.`,
            { field: name, option: resource.uri },
          ),
        );
      }
    }
    const string =
      field.type === "string"
        ? field
        : field.type === "array"
        ? field.items
        : undefined;
    if (string && "pattern" in string && string.pattern) {
      if (string.pattern.length > 1024)
        throw new PluginFormError("PLUGIN_FORM_TOO_LARGE", name);
      try {
        RE2JS.compile(string.pattern);
      } catch {
        throw new PluginFormError("PLUGIN_FORM_PATTERN_UNSUPPORTED", name);
      }
    }
    if (
      string &&
      "x-openai-suggestions" in string &&
      (string["x-openai-suggestions"]?.length ?? 0) > 128
    )
      throw new PluginFormError("PLUGIN_FORM_TOO_LARGE", name);
    // Spec rules for thumbnails: logged for authors, never refused. A
    // thumbnail is not an input; one this client won't load shows the
    // fallback image, like an option without one.
    const thumbnailOptions: { label: string; thumbnail: unknown }[] = input
      ? input.options.map((resource) => ({
          label: resource.title ?? resource.name,
          thumbnail: resource._meta?.["openai/thumbnail"],
        }))
      : (
          [
            ...richOptions,
            ...((string && "x-openai-suggestions" in string
              ? string["x-openai-suggestions"]
              : undefined) ?? []),
          ] as { title?: string; const?: string; [key: string]: unknown }[]
        ).map((option) => ({
          label: option.title ?? option.const ?? "",
          thumbnail: option["x-openai-thumbnail"] ?? option["x-openai-preview"],
        }));
    const unsafe = thumbnailOptions.filter(
      ({ thumbnail }) =>
        thumbnail !== undefined && !pluginFormThumbnailSource(thumbnail),
    );
    if (unsafe.length)
      note(
        pluginDiagnostic(
          "warning",
          "PLUGIN_FORM_THUMBNAIL_SOURCE_INVALID",
          `Form field "${name}": thumbnail not shown`,
          `A thumbnail MUST be an icon whose src is an https: URL or a base64 data: image. ${unsafe.length} option(s) use something else, so they show the fallback image.`,
          {
            field: name,
            options: unsafe.slice(0, 8).map(({ label }) => label),
          },
        ),
      );
    const withThumbnail = thumbnailOptions.filter(
      ({ thumbnail }) => thumbnail !== undefined,
    ).length;
    if (withThumbnail > 0 && withThumbnail < thumbnailOptions.length)
      note(
        pluginDiagnostic(
          "warning",
          "PLUGIN_FORM_THUMBNAIL_PARTIAL",
          `Form field "${name}": some options have no thumbnail`,
          `When any option has a thumbnail, every option SHOULD have one. ${thumbnailOptions.length - withThumbnail} of ${thumbnailOptions.length} options show the fallback image.`,
          { field: name },
        ),
      );
  }
  return {
    schema,
    fields: entries.map(([name, field]) => ({
      name,
      field,
      required: schema.required?.includes(name) ?? false,
    })),
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

/** Name the field and reason a form is Unsupported, for the Logs panel.
 * Covers schema refusals (including the server MUST rules for resource
 * selection: no `selection` on single-select, defaults only from `options`,
 * no default with implicit selection) and missing host services. */
export function pluginFormUnsupportedDiagnostic(
  error: unknown,
  raw?: unknown,
): PluginDiagnostic {
  let code = "PLUGIN_FORM_UNSUPPORTED";
  let field: string | undefined;
  let reason: string | undefined;
  if (error instanceof PluginFormError) {
    code = /^PLUGIN_FORM_[A-Z_]+$/.test(error.message)
      ? error.message
      : code;
    field = error.field;
    if (error.keyword)
      reason = `It uses "${error.keyword}", which this client doesn't support.`;
  } else if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path ?? [];
    const names =
      record(raw) && record(raw.properties) ? Object.keys(raw.properties) : [];
    field =
      path[0] !== "properties"
        ? undefined
        : typeof path[1] === "string"
          ? path[1]
          : typeof path[1] === "number"
            ? names[path[1]]
            : undefined;
    const rawField =
      field && record(raw) && record(raw.properties)
        ? raw.properties[field]
        : undefined;
    reason = rawFieldReason(rawField) ?? (issue ? zodReason(issue) : undefined);
  }
  const described = describePluginError(code) ?? "This form can't be shown.";
  return pluginDiagnostic(
    "error",
    code,
    field ? `Form unsupported: field "${field}"` : "Form unsupported",
    field
      ? `Field "${field}": ${reason ?? described}${reason ? ` ${described}` : ""}`
      : `${reason ? `${reason} ` : ""}${described}`,
    {
      ...(field ? { field } : {}),
      ...(reason ? { reason: reason.slice(0, 300) } : {}),
    },
  );
}

const FIELD_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);
const INPUT_TYPES = new Set(["resource", "file"]);

/** An unknown field or input type, named plainly before any parser wording. */
function rawFieldReason(field: unknown): string | undefined {
  if (field === undefined) return;
  if (!record(field)) return "It isn't a form field.";
  const input = field["x-openai-input"];
  if (input !== undefined) {
    const type = record(input) ? input.type : undefined;
    if (typeof type !== "string" || !INPUT_TYPES.has(type))
      return `It asks for ${
        typeof type === "string"
          ? `a "${type.slice(0, 60)}" input`
          : "an input"
      }, which this client doesn't support.`;
  }
  if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type))
    return `It has the field type ${
      typeof field.type === "string"
        ? `"${field.type.slice(0, 60)}"`
        : "(none)"
    }, which this client doesn't support.`;
  return undefined;
}

/** The most specific reason inside a (possibly union) schema issue. */
function zodReason(issue: z.core.$ZodIssue): string {
  const branches =
    issue.code === "invalid_union" &&
    Array.isArray((issue as { errors?: unknown }).errors)
      ? ((issue as { errors: z.core.$ZodIssue[][] }).errors ?? [])
      : [];
  const nested = branches.flat();
  if (
    nested.some(
      (candidate) =>
        candidate.path.includes("x-openai-input") &&
        candidate.path.includes("selection"),
    )
  )
    return "selection is only allowed on multi-select (array) resource fields.";
  if (branches.length) {
    const closest = [...branches].sort((a, b) => a.length - b.length)[0];
    if (closest?.[0]) return zodReason(closest[0]);
  }
  const message = issue.message.replace(/^Invalid input: /, "");
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

export function initialPluginFormValues(
  plan: PluginFormPlan,
): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null);
  for (const { name, field, required } of plan.fields) {
    const input = pluginFormResources(field);
    values[name] =
      input?.selection === "implicit"
        ? input.options.map((resource) => resource.uri)
        : "default" in field && field.default !== undefined
        ? structuredClone(field.default)
        : field.type === "array"
        ? []
        : field.type === "boolean"
        ? required
          ? false
          : undefined
        : "enum" in field || "oneOf" in field
        ? undefined
        : "";
  }
  return values;
}

/** Typed answers, never JSON-stringified arrays or fabricated optional answers. */
export function buildPluginFormContent(
  plan: PluginFormPlan,
  values: Record<string, unknown>,
) {
  const content: Record<string, unknown> = Object.create(null);
  for (const { name, field, required } of plan.fields) {
    if (!Object.hasOwn(values, name)) continue;
    const value = values[name];
    const emptyChoice =
      ("enum" in field && field.enum?.includes("")) ||
      pluginFormOptions(field).some((option) => option.const === "");
    if (
      value === undefined ||
      value === null ||
      ((field.type === "number" || field.type === "integer") &&
        typeof value === "string" &&
        !value.trim()) ||
      (value === "" && !required && !emptyChoice) ||
      (!required && Array.isArray(value) && !value.length)
    )
      continue;
    content[name] =
      field.type === "number" || field.type === "integer"
        ? typeof value === "string"
          ? Number(value)
          : value
        : structuredClone(value);
  }
  return content;
}

/** RE2 owns patterns; the official validator handles the remaining field contract. */
export function validatePluginFormContent(
  plan: PluginFormPlan,
  content: unknown,
) {
  const errors: Record<string, string> = Object.create(null);
  if (
    !record(content) ||
    Object.keys(content).some(
      (key) => !Object.hasOwn(plan.schema.properties, key),
    )
  )
    return { valid: false, errors, error: "Unexpected form content" };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 256 * 1024)
    return { valid: false, errors, error: "Too much form content" };
  const validation = structuredClone(plan.schema);
  for (const { name, field } of plan.fields) {
    const string =
      field.type === "string"
        ? field
        : field.type === "array"
        ? field.items
        : undefined;
    if (!string || !("pattern" in string) || !string.pattern) continue;
    const raw = content[name];
    const values = Array.isArray(raw) ? raw : [raw];
    const pattern = RE2JS.compile(string.pattern);
    if (
      raw !== undefined &&
      values.some((value) => typeof value !== "string" || !pattern.test(value))
    )
      errors[name] = "Does not match the required pattern";
    const copy = validation.properties[name]!;
    const check =
      copy.type === "string"
        ? copy
        : copy.type === "array"
        ? copy.items
        : undefined;
    if (check && "pattern" in check) delete check.pattern;
  }
  const result = createOpenAIFormContentSchema(validation).safeParse(content);
  if (!result.success)
    for (const issue of result.error.issues) {
      const name = issue.path[0];
      if (typeof name === "string")
        errors[name] = "Does not satisfy the requested field";
    }
  return {
    valid: result.success && !Object.keys(errors).length,
    errors,
    ...(!result.success && !Object.keys(errors).length
      ? { error: "Form content does not satisfy the requested schema" }
      : {}),
  };
}
