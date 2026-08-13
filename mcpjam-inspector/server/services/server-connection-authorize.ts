/**
 * Preparing one browser authorization for a connection request.
 *
 * This is the network half of the OAuth step, and it lives here rather than in
 * Convex for the same reason discovery does: every request below dials a URL
 * the user supplied. Metadata discovery follows `.well-known` paths on that
 * host, registration POSTs to whatever `registration_endpoint` the metadata
 * names, and both are perfectly good SSRF primitives if they run somewhere
 * without a guard. The pinned transport — one DNS resolution, every answer
 * classified, the surviving addresses pinned into the socket, redirects
 * re-validated per hop — is Node-only and is here.
 *
 * WHAT LEAVES THIS MODULE, AND WHAT MUST NOT. It returns an authorization URL
 * for the browser to open, and a `codeVerifier` for the backend to store. Those
 * two must not swap places: the URL is meant to be navigated to, and the
 * verifier is the one value in PKCE that must never reach the browser, or the
 * proof-of-possession it provides is proof of nothing. The caller hands the
 * verifier straight to Convex and returns only the URL to the page.
 *
 * The client is registered per authorization rather than cached. That is a real
 * cost — an extra round trip, and a client record on the provider's side — and
 * it buys the property that matters here: this flow authorizes servers for
 * users who may never have signed in, so there is no durable account-scoped
 * place to keep a client id that would not itself need an owner.
 */

import {
  discoverOAuthServerInfo,
  evaluateResourceIndicator,
  registerClient,
  startAuthorization,
} from "@mcpjam/sdk/browser";
import { createPinnedFetch } from "../utils/pinned-fetch.js";
import { BlockedEgressTargetError } from "../utils/hosted-egress-guard.js";

/** One authorization attempt costs at most this long end to end. Discovery and
 * registration are separate requests against a third party, and a target that
 * stalls each of them must not hold the user's page open indefinitely. */
export const AUTHORIZE_TIMEOUT_MS = 15_000;
export const AUTHORIZE_DEADLINE_MS = 45_000;

export class AuthorizationPrepareError extends Error {
  constructor(
    message: string,
    readonly code:
      | "URL_NOT_ALLOWED"
      | "NO_AUTHORIZATION_SERVER"
      | "UNTRUSTWORTHY_METADATA"
      | "REGISTRATION_FAILED"
      | "UNREACHABLE"
  ) {
    super(message);
    this.name = "AuthorizationPrepareError";
  }
}

export interface PreparedAuthorization {
  /** For the browser. Contains no secret of ours — `state` is a correlator and
   * the code challenge is a one-way digest of the verifier. */
  authorizationUrl: string;
  /** For Convex, and for nothing else. */
  codeVerifier: string;
  state: string;
  clientId: string;
  clientSecret?: string;
  /** Recorded before the redirect so the callback's RFC 9207 `iss` has an
   * authoritative comparison target. Rediscovering it at redemption time would
   * compare the value against itself. */
  issuer?: string;
  /** RFC 8707 resource indicator, when the target published one. */
  oauthResourceUrl?: string;
}

export interface PrepareAuthorizationInput {
  serverUrl: string;
  redirectUri: string;
  requestedName?: string | null;
  allowLoopback?: boolean;
  /** Injected by tests. Production always gets the pinned transport. */
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** A correlator, not a credential — but it still has to be unguessable, because
 * the backend looks an attempt up by its digest and a predictable value would
 * let someone else's callback name your attempt. */
function mintState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Bound the whole preparation, not each request inside it.
 *
 * `timeoutMs` on the transport bounds ONE request, and this makes three or more
 * (resource metadata, authorization-server metadata, registration). Without an
 * outer deadline a target that stalls just under the per-request limit each
 * time still adds up to a page that never answers.
 */
async function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number
): Promise<T> {
  // Racing alone would only stop the CALLER waiting. The work behind the race
  // keeps going, and one of the things it does is register an OAuth client with
  // a third party — so a timed-out attempt could still leave a client record
  // behind for an authorization nobody is waiting for. Aborting the transport
  // is what actually ends it.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      start(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new AuthorizationPrepareError(
              `Preparing authorization took longer than ${deadlineMs}ms.`,
              "UNREACHABLE"
            )
          );
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Also covers the ordinary path: nothing should still be in flight once
    // this function has answered, however it answered.
    controller.abort();
  }
}

/** Attach the deadline's signal to every request the SDK makes.
 *
 * The discovery and registration helpers take a `fetchFn` but no signal of
 * their own, so this is the only seam where one can be threaded through. A
 * caller-supplied `signal` still wins — nothing here overrides an abort the
 * SDK asked for. */
function withSignal(fetchFn: typeof fetch, signal: AbortSignal): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) =>
    await fetchFn(input as RequestInfo, {
      ...init,
      signal: init?.signal ?? signal,
    })) as unknown as typeof fetch;
}

export async function prepareAuthorization(
  input: PrepareAuthorizationInput
): Promise<PreparedAuthorization> {
  const fetchFn =
    input.fetchFn ??
    createPinnedFetch({
      allowLoopback: input.allowLoopback === true,
      timeoutMs: AUTHORIZE_TIMEOUT_MS,
    });

  return await withDeadline(
    (signal) => prepare(input, withSignal(fetchFn, signal)),
    AUTHORIZE_DEADLINE_MS
  );
}

/**
 * Hold the authorization server to RFC 8414's own rule about its identity.
 *
 * `issuer` becomes the trust anchor for the callback's RFC 9207 `iss` check —
 * the value the redemption step compares against. Recording whatever the
 * metadata claims would make that check compare an attacker's assertion with
 * itself: a document that names any issuer it likes would validate perfectly.
 *
 * RFC 8414 §3.3 requires the issuer identifier to be the URL the metadata was
 * retrieved from, minus the well-known suffix. That is exactly
 * `authorizationServerUrl`, so this is a comparison we can actually make, and
 * refusing on mismatch is the only way the later check means anything.
 */
function requireTrustworthyIssuer(
  issuer: string | undefined,
  authorizationServerUrl: string
): string {
  const claimed = issuer?.trim();
  if (!claimed) {
    throw new AuthorizationPrepareError(
      "That authorization server's metadata does not identify an issuer.",
      "UNTRUSTWORTHY_METADATA"
    );
  }
  const normalize = (value: string) => {
    const url = new URL(value);
    // A trailing slash is not a different issuer. Query and fragment are not
    // part of an issuer identifier at all (RFC 8414 §2).
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  };
  try {
    if (normalize(claimed) !== normalize(authorizationServerUrl)) {
      throw new AuthorizationPrepareError(
        `That authorization server's metadata claims a different issuer (${claimed}) than the address it was published at.`,
        "UNTRUSTWORTHY_METADATA"
      );
    }
  } catch (error) {
    if (error instanceof AuthorizationPrepareError) throw error;
    throw new AuthorizationPrepareError(
      "That authorization server's metadata has an unreadable issuer.",
      "UNTRUSTWORTHY_METADATA"
    );
  }
  return claimed;
}

/**
 * Which `token_endpoint_auth_method` to register with.
 *
 * Naming one the server does not support gets the registration rejected, and
 * naming one unconditionally is the same bet made blindly. When the metadata
 * says what it accepts, pick from that list in the order we prefer; when it
 * says nothing, send nothing and let the server apply its own default rather
 * than asserting a capability on its behalf.
 */
function pickAuthMethod(supported: string[] | undefined): string | undefined {
  if (!supported?.length) return undefined;
  for (const preferred of [
    "client_secret_post",
    "client_secret_basic",
    "none",
  ]) {
    if (supported.includes(preferred)) return preferred;
  }
  return supported[0];
}

async function prepare(
  input: PrepareAuthorizationInput,
  fetchFn: typeof fetch
): Promise<PreparedAuthorization> {
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(input.serverUrl, { fetchFn });
  } catch (error) {
    // A blocked target is a VERDICT and must stay one. Letting it fall through
    // to the generic arm would report "we could not reach it", inviting a retry
    // against an address the guard has already refused.
    //
    // It does reach here, and that is worth knowing rather than assuming:
    // `discoverOAuthServerInfo` swallows a failed RESOURCE-metadata leg, but
    // the authorization-server walk it runs afterwards is outside that catch,
    // and `fetchWithCorsRetry` re-throws anything that is not a `TypeError`.
    // Since the fallback authorization-server URL is derived from the same
    // server URL, a target whose host is refused is refused on that leg too.
    if (error instanceof BlockedEgressTargetError) {
      throw new AuthorizationPrepareError(error.message, "URL_NOT_ALLOWED");
    }
    throw new AuthorizationPrepareError(
      `Could not read the authorization server's metadata${
        error instanceof Error && error.message ? `: ${error.message}` : "."
      }`,
      "UNREACHABLE"
    );
  }

  const metadata = info.authorizationServerMetadata;
  if (!metadata) {
    // Discovery said the server needs OAuth but its metadata is unreadable, so
    // there is no endpoint to send the user to. Guessing `/authorize` on the
    // origin — which the SDK will do if asked — would send them somewhere that
    // is probably not an authorization server at all.
    throw new AuthorizationPrepareError(
      "That server asks for OAuth but does not publish authorization server metadata.",
      "NO_AUTHORIZATION_SERVER"
    );
  }

  // Established BEFORE the client is registered: if the server's identity does
  // not check out there is no point creating a client record with it, and the
  // user should not be sent to a consent screen we cannot later verify the
  // return trip from.
  const issuer = requireTrustworthyIssuer(
    (metadata as { issuer?: string }).issuer,
    info.authorizationServerUrl
  );

  const authMethod = pickAuthMethod(
    (metadata as { token_endpoint_auth_methods_supported?: string[] })
      .token_endpoint_auth_methods_supported
  );

  let clientId: string;
  let clientSecret: string | undefined;
  try {
    const registered = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: input.requestedName
          ? `MCPJam - ${input.requestedName}`
          : "MCPJam",
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(authMethod ? { token_endpoint_auth_method: authMethod } : {}),
      },
      fetchFn,
    });
    clientId = registered.client_id;
    clientSecret = registered.client_secret;
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      throw new AuthorizationPrepareError(error.message, "URL_NOT_ALLOWED");
    }
    throw new AuthorizationPrepareError(
      `That server's authorization endpoint refused a client registration${
        error instanceof Error && error.message ? `: ${error.message}` : "."
      }`,
      "REGISTRATION_FAILED"
    );
  }

  const state = mintState();
  // RFC 8707's `resource` binds the token to one server. Taking the advertised
  // value on trust would let a target's own metadata point the indicator at a
  // DIFFERENT resource, and the provider would happily issue a token that works
  // against that one instead of the server the user just approved. The SDK's
  // policy is the strict binding (origin plus path prefix), so it is used here
  // rather than re-derived — a second copy of this rule is a second chance to
  // get it wrong.
  const decision = evaluateResourceIndicator({
    serverUrl: input.serverUrl,
    prmResource: info.resourceMetadata?.resource,
  });
  if (info.resourceMetadata?.resource && !decision.strictClientCompatible) {
    throw new AuthorizationPrepareError(
      `That server advertises a resource identifier (${info.resourceMetadata.resource}) that does not match its own address.`,
      "UNTRUSTWORTHY_METADATA"
    );
  }
  const resource = decision.value;
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    info.authorizationServerUrl,
    {
      metadata,
      clientInformation: { client_id: clientId, client_secret: clientSecret },
      redirectUrl: input.redirectUri,
      state,
      ...(resource ? { resource } : {}),
    }
  );

  return {
    authorizationUrl: authorizationUrl.toString(),
    codeVerifier,
    state,
    clientId,
    clientSecret,
    issuer,
    oauthResourceUrl: resource ? String(resource) : undefined,
  };
}
