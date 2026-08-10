/**
 * Turns a hosted OAuth refresh failure into toast copy.
 *
 * Two failures reach the user through the same thrown error, and they need
 * opposite actions:
 *
 * - The authorization server could not be reached at all, so discovery never
 *   got as far as the token request. Retrying may work.
 * - The authorization server answered and rejected the stored refresh token.
 *   Retrying never works; the user has to authorize again.
 *
 * Every value below is read off the error. Nothing is filled in by hand, so a
 * host is only ever named next to the response that host actually returned.
 */

export type HostedOAuthFailureKind = "unreachable" | "declined" | "unknown";

export interface HostedOAuthFailureCopy {
  kind: HostedOAuthFailureKind;
  title: string;
  /** Lines rendered under the title, in order. May be empty. */
  detail: string[];
  action: "retry" | "reconnect" | null;
}

/** `HTTP 530 trying to load OAuth metadata from https://host/... (body)` */
const METADATA_FAILURE =
  /HTTP (\d{3}) trying to load (?:OAuth|OpenID provider) metadata from (\S+?)(?:\s+\(([^)]*)\))?\s*$/i;

/** The token endpoint answered, and the answer was "no". */
const DECLINED =
  /invalid[_\s-]?grant|InvalidGrantError|refresh[_\s-]?token[_\s-]?not[_\s-]?found|token is not active|expired (?:access\/)?refresh token/i;

function toMessage(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : "";

  return raw
    .replace(/\s+/g, " ")
    .replace(/^Uncaught\s+(?:\w*Error):\s*/i, "")
    .trim();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Pulls the provider's own words out of a wrapped error. The backend nests the
 * upstream payload behind `Raw body:`, which is the part worth showing; the
 * schema-validation noise in front of it is not.
 */
function upstreamDetail(message: string): string | null {
  const rawBody = message.match(/Raw body:\s*(.+)$/i);
  if (rawBody?.[1]) {
    return rawBody[1].trim();
  }

  const status = message.match(/HTTP (\d{3})/i);
  return status ? `HTTP ${status[1]}` : null;
}

export function describeHostedOAuthFailure(
  error: unknown,
  serverName: string
): HostedOAuthFailureCopy | null {
  const message = toMessage(error);
  if (!message) {
    return null;
  }

  const metadata = message.match(METADATA_FAILURE);
  if (metadata) {
    const [, status, url, body] = metadata;
    const host = hostOf(url);
    return {
      kind: "unreachable",
      title: `Could not reach ${host ?? url}`,
      detail: [`GET ${url}`, body ? `HTTP ${status}, ${body}` : `HTTP ${status}`],
      action: "retry",
    };
  }

  if (DECLINED.test(message)) {
    const detail = upstreamDetail(message);
    return {
      kind: "declined",
      title: `Refresh token declined for ${serverName}`,
      detail: detail ? [detail] : [message],
      action: "reconnect",
    };
  }

  return null;
}
