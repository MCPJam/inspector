/**
 * Safety analysis for URL-mode elicitation targets.
 *
 * A server picks this URL and we ask the user to open it, so the client's job
 * is to let them see exactly where they're going before they consent (MCP
 * 2025-11-25, elicitation §Safe URL Handling):
 *
 *   - show the FULL url before consent (never a shortened/derived label)
 *   - highlight the host so subdomain spoofing is visible
 *   - warn on ambiguous/suspicious URIs (punycode)
 *   - never pre-fetch the URL or any metadata
 *
 * Pure and synchronous BY DESIGN: this module must never touch the network.
 * A favicon peek or a HEAD "just to check" would be exactly the pre-fetch the
 * spec forbids, and would leak that the user is looking at the prompt.
 */

export type ElicitationUrlWarning =
  /** Hostname contains an xn-- label: renders as unicode that can mimic another domain. */
  | "punycode"
  /** http:// — credentials/tokens in the flow would cross the wire in clear. */
  | "insecure-scheme"
  /** user:pass@host — a classic way to make a hostile host look legitimate. */
  | "embedded-credentials"
  /** Bare IP host: no domain identity to evaluate. */
  | "ip-host";

export interface ElicitationUrlAnalysis {
  parsed: URL | null;
  warnings: ElicitationUrlWarning[];
  /**
   * True when the URL must not be opened at all: unparseable, or a scheme
   * outside http/https (javascript:, data:, file: — none of which are a
   * legitimate "visit this page" target, and all of which are dangerous to
   * hand to `window.open`).
   */
  blocked: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function analyzeElicitationUrl(raw: string): ElicitationUrlAnalysis {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { parsed: null, warnings: [], blocked: true };
  }

  const warnings: ElicitationUrlWarning[] = [];

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { parsed, warnings, blocked: true };
  }
  if (parsed.protocol === "http:") warnings.push("insecure-scheme");
  if (parsed.username || parsed.password) warnings.push("embedded-credentials");

  const hostname = parsed.hostname;
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) {
    warnings.push("punycode");
  }
  if (IPV4.test(hostname) || hostname.startsWith("[")) warnings.push("ip-host");

  return { parsed, warnings, blocked: false };
}

export const URL_WARNING_COPY: Record<ElicitationUrlWarning, string> = {
  punycode:
    "This address uses characters that can look like a different, well-known site. Check it carefully.",
  "insecure-scheme":
    "This link is not encrypted (http). Anything you enter there could be read in transit.",
  "embedded-credentials":
    "This link embeds a username or password, which can disguise the real destination.",
  "ip-host": "This link points at a raw IP address rather than a named domain.",
};

/** Split for display: the host is emphasized, everything else is muted. */
export function splitUrlForDisplay(parsed: URL): {
  origin: string;
  host: string;
  rest: string;
} {
  return {
    origin: `${parsed.protocol}//`,
    host: parsed.host,
    rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}
