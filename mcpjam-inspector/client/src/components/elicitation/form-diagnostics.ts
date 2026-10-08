import {
  compilePluginForm,
  pluginFormUnsupportedDiagnostic,
  PluginFormError,
  type PluginFormPlan,
  type PluginFormProfile,
} from "@/shared/plugin-extensions/form-plan";
import {
  appendPluginDiagnostics,
  type PluginDiagnostic,
} from "@/lib/plugin-diagnostics";

/** Plain wording for a whole-form refusal; no protocol or schema terms. */
const REASONS: Record<string, string> = {
  PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED:
    "Adding your own files isn't available in forms opened from an App while this client's File resources extension is off.",
  PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE:
    "Adding your own files or folders isn't available here.",
  PLUGIN_FORM_PREVIEW_SERVICE_UNAVAILABLE:
    "Previews for these choices aren't available here.",
  PLUGIN_FORM_PREVIEW_INVALID: "One of the choices has a malformed preview.",
  PLUGIN_FORM_PATTERN_UNSUPPORTED:
    "It asks for a text format this client can't check.",
  PLUGIN_FORM_TOO_LARGE: "It has too many choices or too much content.",
};
const DEFAULT_REASON = "It uses an input this client doesn't support.";

export type UnsupportedPluginForm = {
  /** Field title when one field is responsible; absent for whole-form limits. */
  field?: string;
  reason: string;
  code: string;
  /** The Logs entry for this refusal (validator wording stays there). */
  diagnostic: PluginDiagnostic;
};

/** Server-side rules the card can explain in plain words. */
const SCHEMA_RULES: [RegExp, string][] = [
  [
    /Implicit selection cannot specify a default/,
    "The server set a default for a list you add to and remove from, which isn't allowed.",
  ],
  [
    /Defaults must name supplied resources/,
    "The server's default isn't one of the offered choices.",
  ],
  [
    /selection is only allowed on multi-select/,
    "The server set a selection mode on a field that takes one choice, which isn't allowed.",
  ],
];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
type Issue = { message?: unknown; errors?: unknown };
/** Union failures nest their branch issues; flatten them for matching. */
function issuesOf(value: unknown, depth = 0): Issue[] {
  if (!Array.isArray(value) || depth > 4) return [];
  return value.flatMap((entry) =>
    Array.isArray(entry)
      ? issuesOf(entry, depth + 1)
      : record(entry)
        ? [entry as Issue, ...issuesOf((entry as Issue).errors, depth + 1)]
        : [],
  );
}
/** The card's plain reason; the diagnostic carries the author wording. */
function plainReason(error: unknown, diagnostic: PluginDiagnostic) {
  const messages = [
    ...(record(error) && "issues" in error ? issuesOf(error.issues) : []).map(
      (issue) => String(issue.message ?? ""),
    ),
    String(diagnostic.details?.reason ?? ""),
  ].join("; ");
  const rule = SCHEMA_RULES.find(([pattern]) => pattern.test(messages));
  return rule?.[1] ?? REASONS[diagnostic.code] ?? DEFAULT_REASON;
}
function fieldTitle(raw: unknown, name: string) {
  const field =
    record(raw) && record(raw.properties) ? raw.properties[name] : undefined;
  const title =
    record(field) && typeof field.title === "string" && field.title.trim()
      ? field.title.trim()
      : name;
  return title.slice(0, 120);
}

/**
 * Compile the whole form. On refusal the shared diagnostic names the field
 * and reason for Logs; the card gets a plain reason and the field's title.
 * A form is never partially displayed.
 */
export function compileComposerForm(
  raw: unknown,
  profile: PluginFormProfile,
):
  | { plan: PluginFormPlan; unsupported?: undefined }
  | { plan?: undefined; unsupported: UnsupportedPluginForm } {
  try {
    return { plan: compilePluginForm(raw, profile) };
  } catch (error) {
    const diagnostic = pluginFormUnsupportedDiagnostic(error, raw);
    let field =
      typeof diagnostic.details?.field === "string"
        ? diagnostic.details.field
        : undefined;
    // A whole-form refusal without a named field: find the first field that
    // is refused on its own.
    if (!field && record(raw) && record(raw.properties))
      for (const [name, value] of Object.entries(raw.properties).slice(0, 64))
        try {
          compilePluginForm(
            { type: "object", properties: { [name]: value } },
            profile,
          );
        } catch (fieldError) {
          if (fieldError instanceof PluginFormError || record(fieldError)) {
            field = name;
            break;
          }
        }
    return {
      unsupported: {
        ...(field ? { field: fieldTitle(raw, field) } : {}),
        code: diagnostic.code,
        reason: plainReason(error, diagnostic),
        diagnostic,
      },
    };
  }
}

/**
 * One Logs write per compiled form: the plan's author diagnostics (dropped
 * previews, thumbnail and resource-selection rules), or the one refusal.
 */
export function logComposerFormDiagnostics(
  compiled: ReturnType<typeof compileComposerForm>,
  owner: { serverId?: string; serverName?: string },
) {
  appendPluginDiagnostics(
    compiled.plan
      ? (compiled.plan.diagnostics ?? [])
      : [compiled.unsupported.diagnostic],
    owner,
  );
}
