/**
 * The transport half of "a credential may only go where it was saved for".
 *
 * WHETHER a stored credential may be used for a connection is decided by the
 * backend, which refuses the reveal when the server now points somewhere the
 * credential was not saved for, and says where it WAS saved for (`bound`,
 * `boundOrigins`). This module does not re-make that decision. It enforces the
 * one thing only the process holding the plaintext can: on the wire, the
 * credential's headers are attached only to requests whose origin is one the
 * backend bound — hop by hop, across redirects.
 *
 * Why a wrapper and not the fetch's own redirect handling: Fetch (and the
 * pinned transports) drop `Authorization` and cookies on a cross-origin
 * redirect, but a stored credential is often an `x-api-key` or a vendor header
 * no generic rule knows about. A server that answers `307 Location:
 * https://collector.example/` would otherwise receive it.
 */

/**
 * The http(s) origin a credential is bound to: scheme + host + non-default
 * port. `null` for anything that cannot be reduced to one. Same rules as the
 * backend's `originForCredentialBinding` (`convex/lib/canonicalUrl.ts` in
 * mcpjam-backend): a trailing dot is stripped (one host must not present as
 * two origins), and non-http(s) schemes are refused (`URL.origin` answers the
 * opaque `"null"` for them, which would compare equal across unrelated URLs).
 */
export function credentialOrigin(
  url: string | URL | null | undefined,
): string | null {
  const value = url instanceof URL ? url.toString() : url;
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  parsed.hostname = host;
  return parsed.origin;
}

export interface CredentialHeaderBinding {
  /** The header names that carry the stored credential (case-insensitive). */
  headerNames: readonly string[];
  /** The origins the backend bound the credential to. Empty ⇒ attach nowhere. */
  boundOrigins: readonly string[];
}

const MAX_REDIRECTS = 20;

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
];

/**
 * Credentials Fetch itself removes when a redirect crosses origins. Following
 * redirects here (`redirect: "manual"` underneath) takes that job away from
 * the underlying fetch, so it is done here too — for headers that are not
 * the stored credential's, e.g. an OAuth or XAA bearer set on the same
 * connection. Once removed they stay removed, as in Fetch.
 */
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
];

/**
 * Wrap a transport fetch so the binding's headers only ever reach a bound
 * origin. A binding with no header names is a no-op wrapper.
 *
 * Redirects are followed HERE (the underlying fetch is asked for `manual`), so
 * each hop's origin is checked before the credential headers are attached to
 * it; everything else about the hop — address pinning, the egress guard — stays
 * the underlying fetch's job, which still runs on every hop because every hop
 * is its own call. A caller that asked for `redirect: "manual"` or `"error"`
 * keeps that behavior: one request, one check.
 */
export function bindCredentialHeaders(
  baseFetch: typeof fetch,
  binding: CredentialHeaderBinding,
): typeof fetch {
  const names = binding.headerNames.map((name) => name.toLowerCase());
  if (names.length === 0) return baseFetch;
  const bound = new Set(
    binding.boundOrigins
      .map((origin) => credentialOrigin(origin))
      .filter((origin): origin is string => origin !== null),
  );
  const strip = (headers: Headers, url: string): Headers => {
    const origin = credentialOrigin(url);
    if (origin !== null && bound.has(origin)) return headers;
    const next = new Headers(headers);
    for (const name of names) next.delete(name);
    return next;
  };

  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const fromRequest =
      typeof input !== "string" && !(input instanceof URL) ? input : undefined;
    let url = fromRequest
      ? fromRequest.url
      : typeof input === "string"
        ? input
        : input.toString();
    let headers = new Headers(init?.headers ?? fromRequest?.headers);
    let method = (init?.method ?? fromRequest?.method ?? "GET").toUpperCase();
    // A `Request` input carries its own body and options; every hop is sent
    // as (url, init), so they are lifted into the init here — a body is read
    // once into a buffer, which also makes it replayable across a 307/308.
    let body: RequestInit["body"] = init?.body;
    if (
      body === undefined &&
      fromRequest?.body &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      body = await fromRequest.clone().arrayBuffer();
    }
    const redirectMode = init?.redirect ?? fromRequest?.redirect ?? "follow";
    // Of a Request's remaining options only its abort signal means anything
    // to a server-side fetch; the rest (cache, referrer, …) are browser-only.
    const requestInit: RequestInit = {
      ...(fromRequest ? { signal: fromRequest.signal } : {}),
      ...init,
    };

    if (redirectMode !== "follow") {
      return baseFetch(url, {
        ...requestInit,
        method,
        body,
        headers: strip(headers, url),
        redirect: redirectMode,
      });
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await baseFetch(url, {
        ...requestInit,
        method,
        body,
        headers: strip(headers, url),
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (!isRedirect(response.status) || !location) return response;

      const nextUrl = new URL(location, url).toString();
      // The redirect's own body is never read; release its socket.
      await response.body?.cancel().catch(() => undefined);
      const nextOrigin = credentialOrigin(nextUrl);
      if (nextOrigin === null || nextOrigin !== credentialOrigin(url)) {
        headers = new Headers(headers);
        for (const name of CROSS_ORIGIN_CREDENTIAL_HEADERS) {
          headers.delete(name);
        }
      }
      // Fetch's method rewrite: 301/302 rewrite POST, 303 rewrites everything
      // except GET/HEAD, 307/308 rewrite nothing.
      if (
        ((response.status === 301 || response.status === 302) &&
          method === "POST") ||
        (response.status === 303 && method !== "GET" && method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        for (const name of BODY_HEADERS) headers.delete(name);
      } else if (
        body !== undefined &&
        body !== null &&
        typeof body !== "string" &&
        !(body instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(body) &&
        !(body instanceof URLSearchParams) &&
        !(body instanceof Blob)
      ) {
        throw new Error(
          "A redirect would need the request body replayed, which is not possible for a streamed body.",
        );
      }
      url = nextUrl;
    }
    throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
  };
  return wrapped as typeof fetch;
}

/**
 * The origins a reveal response bound its credential to. Reads the broker's
 * `boundOrigins`; a backend that predates the broker sends only
 * `secretsBoundOrigin`, which reduces to the same one-element list — or to an
 * empty one, which attaches the headers nowhere.
 */
export function boundOriginsFromReveal(body: {
  boundOrigins?: unknown;
  secretsBoundOrigin?: unknown;
}): string[] {
  if (Array.isArray(body.boundOrigins)) {
    return body.boundOrigins.filter(
      (origin): origin is string => typeof origin === "string",
    );
  }
  const legacy =
    typeof body.secretsBoundOrigin === "string"
      ? credentialOrigin(body.secretsBoundOrigin)
      : null;
  return legacy ? [legacy] : [];
}

/**
 * The binding for stored headers an authorize response carried INLINE (a row
 * whose headers were never moved behind the reveal). No reveal ran, so no
 * backend answer names their origins: they are held to the origin the
 * authorize response recorded for them (an empty record binds them nowhere),
 * or, when it recorded none, to the server's own origin — the one connection
 * the backend just authorized. `null` when there
 * are no header values to bind.
 */
export function bindingForAuthorizedHeaders(serverConfig: {
  url?: string | null;
  headers?: Record<string, string> | null;
  boundOrigins?: unknown;
  secretsBoundOrigin?: unknown;
}): CredentialHeaderBinding | null {
  const headers = serverConfig.headers ?? {};
  const headerNames = Object.keys(headers).filter(
    (name) => typeof headers[name] === "string" && headers[name] !== "",
  );
  if (headerNames.length === 0) return null;
  // Anything the backend said, even an empty list ("attach nowhere"), is
  // the answer. Only a response that names no origin at all falls back to the
  // server's own.
  if (
    serverConfig.boundOrigins !== undefined ||
    serverConfig.secretsBoundOrigin !== undefined
  ) {
    return { headerNames, boundOrigins: boundOriginsFromReveal(serverConfig) };
  }
  const own = credentialOrigin(serverConfig.url);
  return { headerNames, boundOrigins: own ? [own] : [] };
}
