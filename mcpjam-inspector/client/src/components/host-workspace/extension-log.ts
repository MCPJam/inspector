import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";

/**
 * Plain-English diagnostics for plugin extensions, written to the existing
 * Logs panel through the shared plugin-extension helper. No new UI: when
 * something can't work, the user sees a short error where it happened and
 * the reason here.
 */
export function logExtensionEvent(event: {
  serverId: string;
  serverName?: string;
  /** Short event label, e.g. "launch" or "file-viewer". */
  label: string;
  level: "info" | "warning" | "error";
  message: string;
  detail?: Record<string, unknown>;
}): void {
  logPluginExtensionIssue({
    code: `workspace/${event.label}`,
    message: event.message,
    level: event.level,
    serverId: event.serverId,
    ...(event.serverName ? { serverName: event.serverName } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  });
}

/** Codes the host returns, described for a server author. */
const DESCRIPTIONS: Record<string, string> = {
  APPROVAL_DENIED: "Tool approval was denied.",
  INSTANCE_UNAVAILABLE:
    "The App's instance is no longer available. Close it and open it again.",
  INSTANCE_DENIED: "This App belongs to a different chat or client.",
  INSTANCE_BINDING_CHANGED:
    "The server changed this App's tool while it was open. Close it and open it again.",
  ACTIVATION_BINDING_CHANGED:
    "The server changed this App's tool while it was open. Close it and open it again.",
  INSTANCE_DEEP_LINK_UNAVAILABLE:
    "No global App with that tool accepts this link.",
  INSTANCE_RESPONSE_INVALID: "The host returned a response the App can't use.",
  INSTANCE_RESPONSE_TOO_LARGE: "The App's response was too large.",
  INSTANCE_UI_UNAVAILABLE:
    "The App's UI resource couldn't be read, isn't text/html;profile=mcp-app, or is over 1 MB.",
  INSTANCE_UNSUPPORTED_CONTINUATION:
    "The tool asked for input in a way this client can't answer.",
  INSTANCE_LIMIT: "Too many Apps are open. Close one and try again.",
  ACTIVATION_SCHEMA_INVALID:
    "The entrypoint's input schema doesn't accept the arguments this entrypoint sends.",
};

export function describeExtensionError(error: unknown): string {
  // The host transport may already carry a plain description.
  const description =
    error && typeof error === "object" && "description" in error
      ? (error as { description?: unknown }).description
      : undefined;
  const candidates =
    error && typeof error === "object" && "candidates" in error
      ? (error as { candidates?: unknown }).candidates
      : undefined;
  const named =
    Array.isArray(candidates) && candidates.length
      ? candidates.filter((item): item is string => typeof item === "string")
      : [];
  if (typeof description === "string" && description.trim())
    return named.length && !named.every((name) => description.includes(name))
      ? `${description} (${named.join(", ")})`
      : description;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code && DESCRIPTIONS[code]) return DESCRIPTIONS[code];
  if (error instanceof Error && error.message && !/^[A-Z_]+$/.test(error.message))
    return error.message;
  return code
    ? `The App couldn't open (${code}).`
    : "The App couldn't open.";
}
