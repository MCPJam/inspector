/**
 * Format a hostContext blob into a structured block to prepend to the
 * model's system prompt. The model can then ground its answers in the
 * host environment (locale, timezone, device capabilities, etc.) the
 * way real chat hosts do.
 *
 * Shared (not server-only) so the inspector can build identical text
 * client-side for previews / debug surfaces.
 *
 * Returns `undefined` when the input has no recognizable fields — the
 * caller skips prepending in that case, so users who don't tweak the
 * header don't get an empty block on every run.
 */

/** Stable field order — keeps the rendered block deterministic for traces. */
const FIELD_ORDER = [
  "locale",
  "timeZone",
  "currentTime",
  "theme",
  "deviceCapabilities",
  "safeAreaInsets",
  "userAgent",
  "containerDimensions",
  "displayModes",
] as const;

function formatString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatDeviceCapabilities(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const caps = value as { hover?: boolean; touch?: boolean };
  const parts: string[] = [];
  if (typeof caps.hover === "boolean") parts.push(`hover=${caps.hover}`);
  if (typeof caps.touch === "boolean") parts.push(`touch=${caps.touch}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatSafeAreaInsets(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const insets = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const side of ["top", "right", "bottom", "left"]) {
    const n = insets[side];
    if (typeof n === "number") parts.push(`${side}=${n}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatContainerDimensions(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const dims = value as Record<string, unknown>;
  const w = typeof dims.width === "number" ? dims.width : null;
  const h = typeof dims.height === "number" ? dims.height : null;
  if (w !== null && h !== null) return `${w}x${h}`;
  if (w !== null) return `width=${w}`;
  if (h !== null) return `height=${h}`;
  return null;
}

function formatField(key: string, value: unknown): string | null {
  switch (key) {
    case "locale":
    case "timeZone":
    case "currentTime":
    case "theme":
    case "userAgent":
      return formatString(value);
    case "deviceCapabilities":
      return formatDeviceCapabilities(value);
    case "safeAreaInsets":
      return formatSafeAreaInsets(value);
    case "containerDimensions":
      return formatContainerDimensions(value);
    case "displayModes":
      return Array.isArray(value) && value.length > 0
        ? value.filter((v) => typeof v === "string").join(", ")
        : null;
    default:
      return formatString(value);
  }
}

const FIELD_LABEL: Record<string, string> = {
  locale: "Locale",
  timeZone: "Time zone",
  currentTime: "Current time",
  theme: "Theme",
  deviceCapabilities: "Device capabilities",
  safeAreaInsets: "Safe area insets",
  userAgent: "User agent",
  containerDimensions: "Container dimensions",
  displayModes: "Display modes",
};

/**
 * Render a `<host_context>...</host_context>` block describing the
 * host environment the run is configured for. Returns `undefined`
 * when no recognized field has a value.
 */
export function formatHostContextForSystemPrompt(
  hostContext: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!hostContext || typeof hostContext !== "object") return undefined;

  const lines: string[] = [];
  for (const key of FIELD_ORDER) {
    const rendered = formatField(key, hostContext[key]);
    if (rendered) {
      lines.push(`${FIELD_LABEL[key]}: ${rendered}`);
    }
  }

  if (lines.length === 0) return undefined;
  return `<host_context>\n${lines.join("\n")}\n</host_context>`;
}

/**
 * Prepend the host_context block to a system prompt, separated by a
 * blank line. Safe with `undefined` system / `undefined` block: returns
 * whichever is defined, or `undefined` if both are absent.
 */
export function withHostContextSystemPrompt(
  system: string | undefined,
  hostContext: Record<string, unknown> | undefined | null,
): string | undefined {
  const block = formatHostContextForSystemPrompt(hostContext);
  if (!block) return system;
  if (!system || system.trim() === "") return block;
  return `${block}\n\n${system}`;
}
