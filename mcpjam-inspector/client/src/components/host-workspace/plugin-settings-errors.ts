/**
 * Plain-English descriptions for settings error codes, written for the
 * server author who has to fix them. Unknown codes get a generic sentence;
 * the code itself always goes to the Logs panel alongside.
 */
const SETTINGS_ERROR_DESCRIPTIONS: Record<string, string> = {
  PLUGIN_SETTINGS_OUTPUT_SCHEMA_REQUIRED:
    "The server's settings tools need an outputSchema. Add one to both the read and the update tool.",
  PLUGIN_SETTINGS_READ_ARGUMENTS_INVALID:
    "The settings read tool must accept an empty object ({}) as its arguments.",
  PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA:
    "The settings schema uses something MCPJam can't show. Use boolean, string (optionally with enum), number or integer properties, and give every property a value.",
  PLUGIN_SETTINGS_TOOL_SCHEMA_INVALID:
    "A settings tool's input or output schema isn't valid JSON Schema.",
  PLUGIN_SETTINGS_TOOL_UNAVAILABLE:
    "The server doesn't list its settings tool anymore. Reconnect the server and try again.",
  PLUGIN_SETTINGS_INVALID_RESULT:
    "The settings tool returned a result that doesn't match its output schema.",
  PLUGIN_SETTINGS_LIMIT: "The settings are too large to show (over 512 KB).",
  PLUGIN_SETTINGS_INVALID_CAPABILITY:
    "The server's openai/settings declaration is malformed.",
  PLUGIN_SETTINGS_AMBIGUOUS_CAPABILITY:
    "The server declares openai/settings in more than one place with different tools.",
  PLUGIN_SETTINGS_ARGUMENTS_INVALID:
    "A settings action tool must accept an empty object ({}) as its arguments.",
  PLUGIN_SETTINGS_ACTION_ARGUMENTS_INVALID:
    "A settings action tool must accept an empty object ({}) as its arguments.",
  PLUGIN_SETTINGS_ACTION_UI_INVALID:
    "A settings App tool doesn't point at a valid ui:// resource.",
  PLUGIN_SETTINGS_INVALID_EDIT:
    "That value isn't allowed by the settings schema.",
  PLUGIN_SETTINGS_UNKNOWN_FIELD: "That setting isn't in the server's schema.",
  PLUGIN_SETTINGS_SCHEMA_CHANGED:
    "The server changed its settings schema. Close and reopen settings.",
  PLUGIN_SETTINGS_REFRESH_REQUIRED:
    "Settings may have changed on the server. Refresh before saving.",
  PLUGIN_SETTINGS_ACTION_REFRESH_REQUIRED:
    "Settings may have changed. Refresh before running another action or saving.",
  PLUGIN_SETTINGS_BUSY: "Another settings call is still running.",
  PLUGIN_SETTINGS_CLOSED: "Settings were closed. Reopen them to continue.",
  PLUGIN_SETTINGS_SAVE_FAILED: "The server couldn't save the settings.",
  PLUGIN_SETTINGS_REFRESH_FAILED: "The server couldn't read the settings.",
  SETTINGS_UNAVAILABLE:
    "Settings aren't available right now. Check that the server is connected and plugin extensions are on for this client.",
  SETTINGS_REQUEST_INVALID: "MCPJam sent a settings request the server route rejected.",
  SETTINGS_RESPONSE_INVALID: "The settings reply couldn't be read.",
  SETTINGS_RESPONSE_LIMIT: "The settings reply was too large (over 1 MB).",
  SETTINGS_CONTINUATION_UNSUPPORTED:
    "The settings tool asked for more input, which settings can't provide.",
};

export function describePluginSettingsError(code: string | undefined): string {
  if (!code) return "The settings call could not be completed.";
  const known = SETTINGS_ERROR_DESCRIPTIONS[code];
  if (known) return known;
  if (code.includes("DENIED")) return "The server call was declined.";
  return "The settings call could not be completed.";
}

export function pluginSettingsErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

const MAX_REPLY_CHARS = 160;

/**
 * The text a settings tool replied with, for the action's status line:
 * text blocks only (never markup), whitespace collapsed, truncated.
 */
export function settingsToolReplyText(
  result: { content?: ReadonlyArray<unknown> } | undefined,
): string {
  const text = (result?.content ?? [])
    .flatMap((block) => {
      const candidate = block as { type?: unknown; text?: unknown } | null;
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_REPLY_CHARS
    ? `${text.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…`
    : text;
}
