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
  work: Promise<T>,
  deadlineMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AuthorizationPrepareError(
                `Preparing authorization took longer than ${deadlineMs}ms.`,
                "UNREACHABLE"
              )
            ),
          deadlineMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  return await withDeadline(prepare(input, fetchFn), AUTHORIZE_DEADLINE_MS);
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
        token_endpoint_auth_method: "client_secret_post",
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
  const resource = info.resourceMetadata?.resource;
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
    issuer: metadata.issuer,
    oauthResourceUrl: resource ? String(resource) : undefined,
  };
}
