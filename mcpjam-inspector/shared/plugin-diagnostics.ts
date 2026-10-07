/** A plain-English diagnostic for the existing Logs panel. Data only: a
 * diagnostic never changes control flow, and it carries no file contents,
 * credentials or tool results. */
export interface PluginDiagnostic {
  level: "error" | "warning" | "info";
  /** Stable machine code, e.g. `PLUGIN_FORM_PREVIEW_DROPPED`. */
  code: string;
  /** One short line for the log row. */
  title: string;
  /** What happened and what a server or App author can do about it. */
  description: string;
  serverId?: string;
  /** Small structured context (field names, option URIs, tool names). */
  details?: Record<string, unknown>;
}

export const PLUGIN_DIAGNOSTICS_MAX = 32;

export function pluginDiagnostic(
  level: PluginDiagnostic["level"],
  code: string,
  title: string,
  description: string,
  details?: Record<string, unknown>,
): PluginDiagnostic {
  return {
    level,
    code,
    title: title.slice(0, 160),
    description: description.slice(0, 1000),
    ...(details ? { details } : {}),
  };
}

/**
 * Plain-English descriptions for error codes that reach users or server/App
 * authors. One shared map: server routes add `description` to error
 * responses, and the client shows the same text in errors and the Logs panel.
 * Codes not listed fall back by prefix; unknown codes have no description.
 */
export const PLUGIN_ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // Sign-in (a call refused, renewed once, and refused again)
  SIGN_IN_EXPIRED:
    "Your sign-in expired before this finished, so it wasn't sent. Retry once your session reconnects, or sign in again.",
  UNAUTHORIZED:
    "Your sign-in expired before this finished, so it wasn't sent. Retry once your session reconnects, or sign in again.",
  // File resources (openai/resources/read, write, subscribe)
  RESOURCE_DENIED:
    "The App asked for a file it wasn't given, or its access to that file has ended. Apps can only read and write the file they were opened with.",
  RESOURCE_INVALID:
    "The App's file request was malformed (for example a bad URI, both text and blob in one write, or invalid base64).",
  RESOURCE_NOT_TEXT:
    'This file isn\'t text. Request representation: "blob" or handle both text and blob.',
  RESOURCE_OUTCOME_UNKNOWN:
    "The file write may or may not have been saved (the connection dropped mid-write). Read the file again before retrying.",
  RESOURCE_READ_REQUIRED:
    "MCPJam gave this App access to its file again (the server restarted, or its hold on the file lapsed), so this save was refused. The App's unsaved changes are still in the viewer: read the file again (resources/read), then save against the ETag it returns.",
  RESOURCE_TOO_LARGE: "The file is larger than the host allows for Apps.",
  RESOURCE_UNSUPPORTED: "This file source doesn't support that operation.",
  // Local files and file targets
  PLUGIN_FILE_TARGETS_NOT_DECLARED:
    'This client lists no files for this server. Add them under the client\'s mcpProfile.extensions["mcpjam/plugin-file-targets"] (a root folder and each file\'s relative path).',
  PLUGIN_LOCAL_FILES_NOT_CONFIGURED:
    "Opening local files is off on this MCPJam install. Set MCPJAM_PLUGIN_LOCAL_FILE_ROOTS to a JSON list of allowed folders, each {actorId, projectId, serverId, root}, then restart MCPJam.",
  PLUGIN_LOCAL_FILE_ROOTS_INVALID:
    "MCPJAM_PLUGIN_LOCAL_FILE_ROOTS isn't valid JSON. It must be a list of {actorId, projectId, serverId, root} entries.",
  PLUGIN_LOCAL_FILE_ROOT_NOT_ALLOWED:
    "This server's file folder isn't allowed for you. Add an entry with your actor ID, this project, this server and the folder to MCPJAM_PLUGIN_LOCAL_FILE_ROOTS, then restart MCPJam.",
  PLUGIN_FILES_COMPUTER_REQUIRED:
    "On the cloud, plugin files live on the project's Computer. Attach the Computer to this client and run the server there to open or save its files.",
  PLUGIN_COMPUTER_FILE_ROOT_INVALID:
    'On the Computer, file target roots must be absolute folders under /home/user. Fix the root in the client\'s "mcpjam/plugin-file-targets".',
  PLUGIN_FILES_REMOTE_SERVER:
    "This server runs remotely over HTTP, so it shares no disk with MCPJam or your Computer. Its local file paths can't be opened or saved here.",
  PLUGIN_COMPUTER_UNAVAILABLE:
    "The project's Computer is asleep or unreachable, so its files can't be opened or saved right now. Send a message in chat to wake it, then try again.",
  PLUGIN_FILE_READ_ONLY:
    "This file is read-only. Only files listed in the client's \"mcpjam/plugin-file-targets\" (in an allowed local folder, or on the project's Computer on the cloud) can be saved.",
  PLUGIN_LOCAL_FILE_NOT_LISTED:
    'That path isn\'t one of the files listed for this server in the client\'s "mcpjam/plugin-file-targets".',
  // App instances
  INSTANCE_UNAVAILABLE:
    "This App session has ended (it was closed, expired or the server restarted). Reopen the App.",
  INSTANCE_DENIED:
    "This App isn't allowed to do that here. It may belong to another chat, client or user, or the request doesn't match how the App was opened.",
  INSTANCE_LIMIT:
    "Too many Apps are open. Close some Apps and try again.",
  INSTANCE_STORE_UNAVAILABLE:
    "Apps can't be opened because the App session store isn't available on this MCPJam server.",
  INSTANCE_RENEWAL_UNAVAILABLE:
    "This MCPJam server can't extend App sessions yet. The App keeps working until its session expires; reopen it afterwards.",
  INSTANCE_HOST_CHANGED:
    "The client's settings changed after this App opened. Reopen the App to use the new settings.",
  INSTANCE_SERVER_CHANGED:
    "The server's saved setup changed after this App opened. Reopen the App.",
  INSTANCE_CONNECTION_CHANGED:
    "The server's connection or credentials changed after this App opened. Reopen the App.",
  INSTANCE_TOOL_UNAVAILABLE:
    "The server no longer lists the tool this App needs.",
  INSTANCE_UI_UNAVAILABLE:
    "The server didn't return a usable App UI (missing ui:// resource, wrong MIME type, or larger than 1 MB).",
  INSTANCE_CONTEXT_UNAVAILABLE:
    "Model context isn't available for this App (the client has it turned off, or the App has closed).",
  INSTANCE_CONTEXT_SEQUENCE_DENIED:
    "A model-context update arrived out of order and was ignored. Send updates one at a time.",
  INSTANCE_CONTEXT_REMOVAL_STALE:
    "That context item already changed, so it couldn't be removed. Try again with the current context.",
  INSTANCE_CONTEXT_TOO_LARGE: "The App's model context is too large.",
  INSTANCE_MESSAGE_UNAVAILABLE:
    "This App can't send chat messages (the client has messages turned off).",
  INSTANCE_REQUEST_BUSY:
    "The App is already running another request. Wait for it to finish.",
  ACTIVATION_SCHEMA_INVALID:
    "The entrypoint tool's input schema doesn't accept the arguments the host must send to open it.",
  ACTIVATION_BINDING_CHANGED:
    "This App was opened with different settings before. Close it and open it again.",
  // Tool calls
  INVOCATION_OUTCOME_UNKNOWN:
    "The tool call reached the server but its result was lost, so MCPJam won't retry it automatically (it may have run). Check the server before trying again.",
  INVOCATION_DENIED: "The tool call isn't allowed for this App.",
  INVOCATION_ID_REUSED:
    "The App reused a request ID for a different tool call.",
  INVOCATION_LIMIT:
    "This App made too many tool calls in its session. Reopen the App.",
  INVOCATION_FAILED: "The tool call failed before it reached the server.",
  INVOCATION_RESULT_EXPIRED:
    "This tool call already ran, but its result is no longer held in memory, so it can't be returned again. The call is not repeated.",
  TOOL_CALL_FAILED:
    "The server returned an error for this tool call. See the server's message for details.",
  APPROVAL_DENIED: "The tool call wasn't approved.",
  APPROVAL_UNAVAILABLE: "Tool approval isn't available right now.",
  AUTHORIZATION_CHANGED:
    "Access changed while the tool call was running, so it was stopped.",
  TOOL_VISIBILITY_DENIED:
    'This tool isn\'t visible to Apps. Add "app" to its _meta.ui.visibility.',
  TOOL_POLICY_DENIED: "The client's tool policy blocks this tool.",
  TOOL_MENTION_DECLARATION_DENIED:
    'This tool isn\'t declared as a mention search tool (_meta["openai/extensions"]["mentions/search"]).',
  PLUGIN_EXTENSION_DISABLED:
    "This client has that OpenAI plugin extension turned off. Turn it on in the client's Apps settings (OpenAI plugin extensions).",
  // Workspace admission
  PLUGIN_WORKSPACE_DENIED:
    "Plugin extensions aren't available for this project or account.",
  PLUGIN_WORKSPACE_CANCELLED: "The request was cancelled.",
  PLUGIN_INSTANCE_CANCELLED: "The request was cancelled.",
  INVALID_PLUGIN_INSTANCE_REQUEST: "The request was malformed.",
  // Deep links
  PLUGIN_DEEP_LINK_INVALID:
    "This isn't a valid plugin link. Plugin links look like chatgpt://plugins/<plugin>/app/<tool>?path=/page (the path must start with / and have no #fragment).",
  PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED:
    "This client doesn't open links with that scheme. The Codex client uses codex://; the ChatGPT client uses chatgpt:// or https://chatgpt.com.",
  PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN:
    "No enabled plugin or server matches the link's plugin ID. Use the plugin's manifest name, its installation ID, or server-<saved server ID> for a plain server.",
  PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH:
    "The link's @marketplace doesn't match the marketplace this plugin was installed from.",
  PLUGIN_DEEP_LINK_AMBIGUOUS:
    "More than one installed plugin matches this link. Add @<marketplace> to the plugin ID, or use the installation ID.",
  PLUGIN_DEEP_LINK_TOOL_UNAVAILABLE:
    "The plugin has no global App entrypoint with the link's tool name.",
  PLUGIN_DEEP_LINK_NAMESPACE_UNAVAILABLE:
    "Deep links can only open a plugin's global App.",
  // Forms
  PLUGIN_FORM_UNSUPPORTED:
    "This form uses a schema feature the client doesn't support.",
  PLUGIN_FORM_UNAVAILABLE: "The form couldn't be loaded.",
  PLUGIN_FORM_TOO_LARGE:
    "The form is too large (too many fields, options or bytes).",
  PLUGIN_FORM_PATTERN_UNSUPPORTED:
    "A field's pattern isn't a supported regular expression.",
  PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED:
    "Forms opened from an App can only ask for file uploads when the client's File resources extension is on. Turn it on in the client's plugin extensions, or remove upload options.",
  PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE:
    "This form asks for file or folder uploads, which this MCPJam server can't provide (configure a local folder, or use a local install).",
  PLUGIN_FORM_PREVIEW_SERVICE_UNAVAILABLE:
    "This client can't render that kind of preview.",
  PLUGIN_FORM_PREVIEW_INVALID:
    'An option\'s _meta["openai/preview"] has no valid target.',
  PLUGIN_FORMS_DISABLED:
    "This client has Forms turned off, so the form takes no answers or uploads. A form that was already open ends as cancelled when it's submitted, and its answer isn't sent to the server. Turn Forms on in the client's OpenAI plugin extensions to answer forms.",
  FORM_SOURCE_UNAVAILABLE:
    "This form has expired or was already answered.",
  FORM_PREVIEW_UNAVAILABLE: "That preview isn't available for this form.",
  PLUGIN_FORM_PREVIEW_TIMEOUT:
    "The preview didn't open within 30 seconds, so MCPJam stopped waiting. The form and its answers are unchanged. Try again; if it keeps happening, check that the server answers the preview's resource read or preview tool promptly.",
  PLUGIN_FORM_PREVIEW_FAILED:
    "The preview couldn't be opened. The form and its answers are unchanged; try again.",
  PLUGIN_FORM_SUBMIT_TIMEOUT:
    "MCPJam didn't confirm the answer within 30 seconds, so it stopped waiting. The answers are still in the form; send them again. A repeat of an answer that did arrive is ignored.",
  PLUGIN_FORM_SUBMIT_FAILED:
    "The answer couldn't be sent. The answers are still in the form; send them again.",
  PLUGIN_FORM_DESTINATION_TIMEOUT:
    "MCPJam couldn't confirm where this form's files would be uploaded within 30 seconds, so it stopped waiting. Nothing was uploaded and the request is still open. Retry, or cancel the request; if it keeps happening, check that the server is still connected and that you're still signed in.",
  PLUGIN_FORM_DESTINATION_FAILED:
    "MCPJam couldn't check where this form's files would be uploaded. Nothing was uploaded and the request is still open; retry, or cancel the request.",
  // Settings
  PLUGIN_SETTINGS_TOOL_UNAVAILABLE:
    'The server\'s openai/settings capability names a read or update tool that tools/list doesn\'t include.',
  PLUGIN_SETTINGS_OUTPUT_SCHEMA_REQUIRED:
    "Both settings tools must declare an outputSchema.",
  PLUGIN_SETTINGS_READ_ARGUMENTS_INVALID:
    "The settings read tool must accept an empty arguments object ({}).",
  PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA:
    "A settings field uses an unsupported type. Settings support boolean, string (with optional enum), number and integer.",
  PLUGIN_SETTINGS_INVALID_RESULT:
    "The settings read tool returned a result that doesn't match its outputSchema, or a field has no value.",
  PLUGIN_SETTINGS_TOOL_SCHEMA_INVALID:
    "A settings tool's schema couldn't be parsed.",
  PLUGIN_SETTINGS_INVALID_CAPABILITY:
    "The server's openai/settings capability is malformed.",
  PLUGIN_SETTINGS_AMBIGUOUS_CAPABILITY:
    "The server declares openai/settings in more than one place with different values.",
  PLUGIN_SETTINGS_SAVE_FAILED: "The server couldn't save the settings.",
  PLUGIN_SETTINGS_SCHEMA_CHANGED:
    "The server's settings changed. Reload settings and try again.",
  PLUGIN_SETTINGS_REFRESH_REQUIRED:
    "Settings changed on the server. Reload settings.",
  PLUGIN_SETTINGS_READ_NOT_READ_ONLY:
    "The settings read tool should be marked read-only (annotations.readOnlyHint: true).",
  SETTINGS_UNAVAILABLE: "Settings aren't available for this server right now.",
  // Mentions
  PLUGIN_MENTION_SEARCH_FAILED:
    "The server's mention search tool returned an error.",
  PLUGIN_MENTION_RESULT_TOO_LARGE: "The mention search result is too large.",
  // File viewers
  PLUGIN_FILE_READ_TIMEOUT:
    "The file didn't load within 12 seconds, so MCPJam stopped waiting. Reload the file in the viewer (or reopen it) to try again. If it keeps happening, check that the server answers resources/read promptly, and close Apps you no longer need: each open file viewer keeps a connection to MCPJam.",
  PLUGIN_FILE_WATCH_TIMEOUT:
    "MCPJam couldn't start watching this file for changes within 12 seconds, so it stopped waiting. The file can still be read; changes made elsewhere won't refresh the viewer until it subscribes again or the file is reopened.",
  // Model App / continuations
  MODEL_APP_UNAVAILABLE: "This App from the chat is no longer available.",
  CONTINUATION_EXPIRED:
    "This form expired before it was answered, so the tool call did not finish. Run it again.",
  CONTINUATION_CANCELLED:
    "This form was cancelled, so the tool call did not finish.",
  CONTINUATION_CONNECTION_UNAVAILABLE:
    "The server disconnected before the answer could be sent. Reconnect and send it again.",
  CONTINUATION_DENIED:
    "This form answer doesn't match the server's current request.",
  CONTINUATION_PROTOCOL_DENIED:
    "The server's MCP version doesn't support this form request.",
};

const PREFIX_DESCRIPTIONS: readonly [string, string][] = [
  ["PLUGIN_DEEP_LINK_", "This plugin link couldn't be opened."],
  ["PLUGIN_SETTINGS_", "The server's settings couldn't be used."],
  ["PLUGIN_FORM_", "This form couldn't be shown."],
  ["RESOURCE_", "The App's file request couldn't be completed."],
  ["INSTANCE_CONTEXT_", "The App's model context couldn't be updated."],
  ["INSTANCE_", "This App session couldn't complete the request. Reopen the App."],
  ["INVOCATION_", "The tool call couldn't be completed."],
  ["CONTINUATION_", "The form answer couldn't be delivered to the server."],
];

/** A short, plain-English description for an error code, when one exists. */
export function describePluginError(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  if (Object.hasOwn(PLUGIN_ERROR_DESCRIPTIONS, code))
    return PLUGIN_ERROR_DESCRIPTIONS[code];
  return PREFIX_DESCRIPTIONS.find(([prefix]) => code.startsWith(prefix))?.[1];
}

/** An error diagnostic for the Logs panel, described from the shared map. */
export function pluginErrorDiagnostic(
  code: string,
  title: string,
  details?: Record<string, unknown>,
): PluginDiagnostic {
  return pluginDiagnostic(
    "error",
    code,
    title,
    describePluginError(code) ?? code,
    details,
  );
}
