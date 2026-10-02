import {
  SdkHttpError,
  SdkErrorCode,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/client";
import {
  parseChallengeHeader,
  type AuthChallengeSignal,
} from "./auth-challenge.js";

/**
 * The protected operations whose HTTP failures are preserved here. A server
 * that allows anonymous `initialize` and listing refuses exactly these.
 *
 * The upstream transport keeps no headers on a non-`tools/call` failure when
 * there is no auth provider, so without this a `401` on `resources/read` or
 * `prompts/get` arrives with no challenge at all.
 */
const PROTECTED_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

function protectedMethodOf(body: RequestInit["body"]): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const method = JSON.parse(body)?.method;
    return typeof method === "string" && PROTECTED_METHODS.has(method)
      ? method
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last `401` challenge seen on this transport.
 *
 * Only used when an auth provider owns 401/403 handling: the transport then
 * raises `UnauthorizedError` (or "401 after re-authentication") WITHOUT the
 * header, so the manager reads the challenge back from here and attaches it to
 * the error it rethrows.
 */
export interface AuthChallengeRecorder {
  last?: { status: 401; challenge: AuthChallengeSignal; at: number };
}

/** Preserve HTTP diagnostics before the transport discards response headers. */
export function wrapFetchForHttpErrors(
  fetchFn: typeof fetch,
  hasAuthProvider: boolean,
  recorder?: AuthChallengeRecorder
): typeof fetch {
  return (async (input, init) => {
    const response = await fetchFn(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST") return response;

    const protectedMethod = protectedMethodOf(init?.body);

    // A 403 needs no recording: `insufficient_scope` reaches the caller as an
    // `InsufficientScopeError` with its fields, and any other 403 is not a
    // sign-in challenge. Only a protected call is recorded: a 401 on
    // `initialize` is a connect-time sign-in, which keeps its own OAuth path
    // and must never be reported as a mid-session challenge.
    if (recorder && response.status === 401 && protectedMethod !== undefined) {
      recorder.last = {
        status: 401,
        challenge: parseChallengeHeader(
          response.headers.get("www-authenticate"),
          "http_401"
        ),
        at: Date.now(),
      };
    }

    if (
      protectedMethod === undefined ||
      response.ok ||
      // HTTP 400 can carry a JSON-RPC error the transport needs to dispatch.
      response.status === 400 ||
      // The transport must handle authentication and scope retries itself.
      // It raises InsufficientScopeError for step-up even without a provider.
      (response.status === 403 &&
        extractWWWAuthenticateParams(response).error ===
          "insufficient_scope") ||
      (hasAuthProvider && (response.status === 401 || response.status === 403))
    ) {
      return response;
    }

    const text = await response.text().catch(() => null);
    const statusLine = [response.status, response.statusText]
      .filter(Boolean)
      .join(" ");
    const challenge = response.headers.get("www-authenticate");
    // Keep the wire value (seconds or HTTP date) for the caller's cooldown
    // policy. Do not retain unrelated headers or decide whether to replay here.
    const retryAfter = response.headers.get("retry-after");
    const body = text === null ? "(unreadable body)" : text || "(empty body)";
    // A 401 is a sign-in challenge even with no `WWW-Authenticate` at all: the
    // spec has clients fall back to the well-known metadata paths. The parsed
    // signal travels as data, not only in the message text.
    const authChallenge =
      response.status === 401
        ? parseChallengeHeader(challenge, "http_401")
        : undefined;
    throw new SdkHttpError(
      response.status === 401
        ? SdkErrorCode.ClientHttpAuthentication
        : response.status === 403
          ? SdkErrorCode.ClientHttpForbidden
          : SdkErrorCode.ClientHttpNotImplemented,
      `Error POSTing to endpoint (HTTP ${statusLine}): ${body}${
        challenge ? `\nWWW-Authenticate: ${challenge}` : ""
      }`,
      {
        status: response.status,
        statusText: response.statusText,
        text,
        ...(retryAfter !== null ? { retryAfter } : {}),
        ...(authChallenge ? { authChallenge } : {}),
      }
    );
  }) as typeof fetch;
}
