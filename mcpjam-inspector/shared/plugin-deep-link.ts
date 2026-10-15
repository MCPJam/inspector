/** Closed navigation grammar shared by the tester and the authorized server. */
export class PluginDeepLinkError extends Error {}

export type PluginDeepLink = {
  scheme: "codex" | "chatgpt" | "https";
  pluginId: string;
  marketplace?: string;
  toolName: string;
  url: string;
};

/** Runtime schemes share one policy across interactive and unattended adapters.
 * The scheme follows the client runtime (its harness), never a platform: the
 * Codex client accepts `codex://`; the ChatGPT client accepts `chatgpt://` and
 * `https://chatgpt.com/…`. */
export function pluginDeepLinkMatchesRuntime(
  link: Partial<PluginDeepLink> & Pick<PluginDeepLink, "scheme">,
  runtime: "chatgpt" | "codex",
) {
  return runtime === "codex"
    ? link.scheme === "codex"
    : link.scheme === "chatgpt" || link.scheme === "https";
}

/** Plain MCP servers have no manifest: their emulated plugin ID is derived from
 * the saved server ID, which is stable and unique within a project. */
export function emulatedServerPluginId(serverId: string) {
  return `server-${serverId}`;
}

/** True when `input` uses the plugin deep-link grammar (any scheme). A cheap
 * check for intercepting clicked links; admission still parses and validates. */
export function isPluginDeepLink(input: unknown): boolean {
  try {
    parsePluginDeepLink(input);
    return true;
  } catch {
    return false;
  }
}

export function parsePluginDeepLink(input: unknown): PluginDeepLink {
  const invalid = () => new PluginDeepLinkError("PLUGIN_DEEP_LINK_INVALID");
  if (
    typeof input !== "string" ||
    input.length > 8192 ||
    /[\s\\#\u0000-\u001f\u007f]/.test(input)
  )
    throw invalid();
  // Match the raw pathname: URL normalization must not erase dot segments,
  // credentials, ports, extra segments, or a hostile authority.
  const custom =
    /^(codex|chatgpt):\/\/plugins\/([^/?]+)\/app\/([^/?]+)(?:\?([^#]*))?$/.exec(
      input,
    );
  const https =
    /^https:\/\/chatgpt\.com\/plugins\/([^/?]+)\/app\/([^/?]+)(?:\?([^#]*))?$/.exec(
      input,
    );
  if (!custom && !https) throw invalid();
  const scheme = custom ? (custom[1] as "codex" | "chatgpt") : "https";
  const namespace = custom ? custom[2] : https![1];
  const rawTool = custom ? custom[3] : https![2];
  const rawQuery = custom ? custom[4] : https![3];
  const parts = namespace.split("@");
  if (parts.length > 2 || (scheme === "https" && parts.length !== 1))
    throw invalid();
  const decode = (value: string) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw invalid();
    }
    if (
      !decoded ||
      decoded.length > 256 ||
      /[\u0000-\u001f\u007f\\]/.test(decoded)
    )
      throw invalid();
    return decoded;
  };
  const pluginId = decode(parts[0]);
  const marketplace = parts[1] === undefined ? undefined : decode(parts[1]);
  const toolName = decode(rawTool);
  if (
    [pluginId, marketplace, toolName].some(
      (value) => value === "." || value === "..",
    )
  )
    throw invalid();
  // URLSearchParams deliberately preserves the decoded inner query, including
  // duplicate inner parameters. The outer envelope has exactly one optional key.
  if (rawQuery && /%(?![\da-f]{2})/i.test(rawQuery)) throw invalid();
  try {
    if (rawQuery) decodeURIComponent(rawQuery);
  } catch {
    throw invalid();
  }
  const query = new URLSearchParams(rawQuery);
  const entries = [...query.entries()];
  if (entries.some(([key]) => key !== "path") || entries.length > 1)
    throw invalid();
  const url = query.get("path") ?? "/";
  if (
    !url.startsWith("/") ||
    url.startsWith("//") ||
    url.length > 4096 ||
    /[\u0000-\u001f\u007f\\#]/.test(url) ||
    new TextEncoder().encode(url).byteLength > 8192
  )
    throw invalid();
  return {
    scheme,
    pluginId,
    ...(marketplace === undefined ? {} : { marketplace }),
    toolName,
    url,
  };
}

/** Build a link for a plugin ID (installation ID, manifest name, published ID
 * or a plain server's emulated ID). */
export function localPluginDeepLink(
  pluginId: string,
  toolName: string,
  runtime: "chatgpt" | "codex",
  url = "/",
) {
  const link = `${runtime}://plugins/${encodeURIComponent(
    pluginId,
  )}/app/${encodeURIComponent(toolName)}?path=${encodeURIComponent(url)}`;
  parsePluginDeepLink(link);
  return link;
}
