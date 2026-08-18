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

/**
 * The `invalid_grant` family, in every spelling that reaches a client: the
 * RFC 6749 code itself, the hyphen/space variants a hand-written server emits,
 * and the `InvalidGrantError` class name a Convex action throws.
 *
 * Exported because {@link import("./oauth/mcp-oauth").formatOAuthCallbackError}
 * classifies the same family on the callback path. One pattern, so extending
 * either classifier cannot leave the other behind.
 */
export const INVALID_GRANT_PATTERN =
  /invalid[_\s-]?grant|InvalidGrantError/i;

/**
 * The token endpoint answered, and the answer was "no". The invalid_client
 * family belongs here: a registration the server has disowned can never
 * refresh, and re-running authorize (which re-registers) is the fix, same as
 * for a dead refresh token.
 */
const DECLINED = new RegExp(
  `${INVALID_GRANT_PATTERN.source}|refresh[_\\s-]?token[_\\s-]?not[_\\s-]?found|token is not active|expired (?:access\\/)?refresh token|invalid[_\\s-]?client|InvalidClientError|unknown client|client authentication failed`,
  "i"
);

/**
 * What the backend recorded off the authorization server's failing response.
 * Travels as `details.failure` on the 503 the hosted refresh path returns
 * (`authorization_server_unreachable`); every field is the other server's, so
 * rendering it verbatim keeps the no-fabrication invariant.
 */
interface AuthorizationServerFailure {
  url: string;
  status: number;
  body: string;
}

function structuredPartsOf(error: unknown): {
  code: string | null;
  details: Record<string, unknown> | null;
} {
  if (!error || typeof error !== "object") {
    return { code: null, details: null };
  }
  const record = error as { code?: unknown; details?: unknown };
  return {
    code: typeof record.code === "string" ? record.code : null,
    details:
      record.details && typeof record.details === "object"
        ? (record.details as Record<string, unknown>)
        : null,
  };
}

function failureOf(
  details: Record<string, unknown> | null
): AuthorizationServerFailure | null {
  const failure = details?.failure;
  if (!failure || typeof failure !== "object") {
    return null;
  }
  const record = failure as Record<string, unknown>;
  if (typeof record.url !== "string" || typeof record.status !== "number") {
    return null;
  }
  return {
    url: record.url,
    status: record.status,
    body: typeof record.body === "string" ? record.body : "",
  };
}

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

  // Structured shapes first: once the backend classifies a refresh failure it
  // answers with a code and a generic message ("Hosted OAuth refresh token is
  // invalid. Please reconnect.") that no provider-message regex below can
  // match — the regexes only ever see errors the backend did NOT classify.
  const { code, details } = structuredPartsOf(error);

  if (
    code === "authorization_server_unreachable" ||
    details?.authorizationServerUnreachable === true
  ) {
    const failure = failureOf(details);
    if (failure) {
      return {
        kind: "unreachable",
        title: `Could not reach ${hostOf(failure.url) ?? failure.url}`,
        detail: [
          failure.url,
          failure.body
            ? `HTTP ${failure.status}, ${failure.body}`
            : `HTTP ${failure.status}`,
        ],
        action: "retry",
      };
    }
    return {
      kind: "unreachable",
      title: "Could not reach the authorization server",
      detail: [message],
      action: "retry",
    };
  }

  if (
    code === "refresh_token_invalid" ||
    details?.refreshTokenInvalid === true
  ) {
    return {
      kind: "declined",
      title: `Refresh token declined for ${serverName}`,
      detail: [message],
      action: "reconnect",
    };
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
