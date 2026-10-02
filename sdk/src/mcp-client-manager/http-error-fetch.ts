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

/**
 * Which operation a protected request performs: the method plus the tool or
 * prompt name, or the resource URI. The manager computes the same key for the
 * operation it is running, so it reads back only that operation's 401.
 */
export function authChallengeOperationKey(
  method: string,
  target: string | undefined
): string {
  return `${method}\u0000${target ?? ""}`;
}

function protectedOperationOf(
  body: RequestInit["body"]
): { method: string; key: string } | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const message = JSON.parse(body);
    const method = message?.method;
    if (typeof method !== "string" || !PROTECTED_METHODS.has(method)) {
      return undefined;
    }
    const target =
      method === "resources/read" ? message.params?.uri : message.params?.name;
    return {
      method,
      key: authChallengeOperationKey(
        method,
        typeof target === "string" ? target : undefined
      ),
    };
  } catch {
    return undefined;
  }
}

export interface RecordedAuthChallenge {
  status: 401;
  challenge: AuthChallengeSignal;
  at: number;
}

/** Operations remembered per transport; the oldest is dropped beyond this. */
const MAX_RECORDED_OPERATIONS = 64;

/**
 * The `401` challenges seen on this transport, per operation.
 *
 * Only used when an auth provider owns 401/403 handling: the transport then
 * raises `UnauthorizedError` (or "401 after re-authentication") WITHOUT the
 * header, so the manager reads the challenge back from here and attaches it to
 * the error it rethrows. Keyed by operation, not kept as one connection-wide
 * value: calls run concurrently, and one call's refusal must never be
 * reported as another's.
 */
export interface AuthChallengeRecorder {
  byOperation?: Map<string, RecordedAuthChallenge>;
  /** The most recent one, of any operation. Diagnostics only. */
  last?: RecordedAuthChallenge;
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

    const operation = protectedOperationOf(init?.body);

    // A 403 needs no recording: `insufficient_scope` reaches the caller as an
    // `InsufficientScopeError` with its fields, and any other 403 is not a
    // sign-in challenge. Only a protected call is recorded: a 401 on
    // `initialize` is a connect-time sign-in, which keeps its own OAuth path
    // and must never be reported as a mid-session challenge.
    if (recorder && response.status === 401 && operation !== undefined) {
      const recorded: RecordedAuthChallenge = {
        status: 401,
        challenge: parseChallengeHeader(
          response.headers.get("www-authenticate"),
          "http_401"
        ),
        at: Date.now(),
      };
      recorder.last = recorded;
      const byOperation = (recorder.byOperation ??= new Map());
      // Re-inserted so the map's order is recency, and the cap drops the
      // operation refused longest ago.
      byOperation.delete(operation.key);
      byOperation.set(operation.key, recorded);
      if (byOperation.size > MAX_RECORDED_OPERATIONS) {
        const oldest = byOperation.keys().next().value;
        if (oldest !== undefined) byOperation.delete(oldest);
      }
    }

    if (
      operation === undefined ||
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
