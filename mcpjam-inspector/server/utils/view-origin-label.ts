import { createHash } from "node:crypto";

/**
 * The label MCPJam serves a server's MCP App views from:
 * `<label>.sandbox.mcpjam.com`.
 *
 * Derived, never declared. `_meta.ui.domain` is a string the SERVER chooses,
 * and routing on it would let one server claim another's origin — and with it
 * that origin's cookies and storage. Claude derives its label the same way, as
 * `sha256(<connector URL>)[:32] + ".claudemcpcontent.com"`.
 *
 * What a stable label buys is the reason to be careful about the input: an
 * origin is where OAuth redirect URIs point and what third-party API-key
 * allowlists name, so a label that changes when nothing meaningful changed
 * silently invalidates a developer's configuration.
 */

/** Hex characters of the digest that go into the label. */
export const VIEW_ORIGIN_LABEL_LENGTH = 16;

/** A label as it may appear in a hostname. */
export const VIEW_ORIGIN_LABEL_PATTERN = /^[a-f0-9]{16}$/;

export interface ViewOriginServerConfig {
  /** HTTP/SSE servers. */
  url?: string;
  /** STDIO servers. */
  command?: string;
  args?: string[];
}

/**
 * The canonical string a label is derived from, or `undefined` when the config
 * identifies nothing.
 *
 * Query and fragment are stripped from a URL. This is a deliberate divergence
 * from Claude, which hashes the connector URL exactly as entered: MCPJam's
 * suffix differs anyway so the digests were never going to agree, and a URL
 * here can carry a resolved token in its query. Hashing that would key an
 * origin on a secret and rotate it whenever the secret did.
 *
 * The shapes mirror `computeServerKey` on the client
 * (`components/ui-playground/hooks/useServerKey.ts`), so the two never
 * disagree about what counts as "the same server".
 */
export function canonicalServerKey(
  config: ViewOriginServerConfig | undefined,
): string | undefined {
  if (!config) return undefined;
  if (typeof config.url === "string" && config.url.length > 0) {
    try {
      const url = new URL(config.url);
      url.search = "";
      url.hash = "";
      return `http:${url.toString()}`;
    } catch {
      // Not parseable as a URL: hash it verbatim rather than dropping the
      // server's identity entirely.
      return `http:${config.url}`;
    }
  }
  if (typeof config.command === "string" && config.command.length > 0) {
    const args = (config.args ?? []).join(" ");
    return `stdio:${config.command} ${args}`.trim();
  }
  return undefined;
}

/** The subdomain label for a canonical key. */
export function viewOriginLabel(key: string): string {
  return createHash("sha256")
    .update(key, "utf8")
    .digest("hex")
    .slice(0, VIEW_ORIGIN_LABEL_LENGTH);
}

/** Convenience: config → label, or `undefined` when it identifies nothing. */
export function viewOriginLabelForConfig(
  config: ViewOriginServerConfig | undefined,
): string | undefined {
  const key = canonicalServerKey(config);
  return key === undefined ? undefined : viewOriginLabel(key);
}
