/** The subset of the MCP `Icon` shape the chat needs to pick one. */
export interface McpServerIcon {
  src: string;
  theme?: "light" | "dark";
}

/**
 * An icon src arrives on an MCP server's initialize response, so it is
 * untrusted content on the same footing as the URLs
 * {@link filterSafeExternalLinkUrls} filters. `<img>` narrows what can go
 * wrong — a `javascript:` src does not execute — but the browser still dials
 * whatever this points at, so hold it to the same allowlist: remote icons over
 * https, plus the inline `data:image/` form MCP tool-result images already use.
 */
function isSafeIconSrc(src: unknown): src is string {
  if (typeof src !== "string" || src.length === 0) return false;
  if (src.startsWith("data:image/")) return true;
  try {
    return new URL(src).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Picks the icon a server declared for the theme on screen, preferring an
 * untagged icon over one meant for the opposite theme so a dark-mode mark
 * never lands on a light chat. BB-136.
 *
 * Tolerant of a malformed `icons` — it comes off the wire, not from us.
 */
export function resolveMcpServerIconSrc(
  icons: McpServerIcon[] | undefined,
  theme: "light" | "dark",
): string | undefined {
  if (!Array.isArray(icons)) return undefined;
  const usable = icons.filter((icon) => isSafeIconSrc(icon?.src));
  if (usable.length === 0) return undefined;
  const match =
    usable.find((icon) => icon.theme === theme) ??
    usable.find((icon) => !icon.theme) ??
    usable[0];
  return match?.src;
}
