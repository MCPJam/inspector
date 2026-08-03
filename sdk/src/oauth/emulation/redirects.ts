/**
 * Completion-safe redirect planning (HP-43 step 5).
 *
 * The emulator must do two things that pull in opposite directions: replay the
 * real client's registration body, and still finish the dance with a real
 * token. A real client registers callbacks MCPJam cannot receive on
 * (`cursor://…`, a vendor's hosted callback, a loopback port owned by another
 * process), so a byte-exact replay would strand the authorization code.
 *
 * The resolution, and its honesty rules:
 *
 *   - The registration body carries the captured redirect URIs **in captured
 *     order, plus MCPJam's callback appended**. The appended entry is a
 *     DECLARED substitution — the registration step can never be presented as
 *     byte-matched when it happens.
 *   - The authorization and token legs **always** use MCPJam's callback, so
 *     the code comes back to us and can be exchanged.
 *   - If the server rejects that registration with a structured RFC 7591
 *     `invalid_redirect_uri`, and only then, the caller may re-register with
 *     MCPJam's callback alone (see `isInvalidRedirectUriRejection`). That is
 *     the second and last registration a preflight will ever perform.
 *
 * There is no exact-foreign-redirect mode: a run that cannot complete produces
 * no token, and a token is what the developer came for.
 */

import type { OAuthEmulationDivergence } from "./types.js";

export interface CompletionSafeRedirectPlan {
  /** `redirect_uris` for the registration body. */
  registrationRedirectUris: string[];
  /** The callback the authorization + token legs use. Always MCPJam's. */
  authorizationRedirectUri: string;
  /** Declared differences from the captured registration. */
  divergences: OAuthEmulationDivergence[];
}

export function planCompletionSafeRedirects(input: {
  capturedRedirectUris?: string[];
  callbackUrl: string;
}): CompletionSafeRedirectPlan {
  const { capturedRedirectUris, callbackUrl } = input;
  const divergences: OAuthEmulationDivergence[] = [];

  if (!capturedRedirectUris || capturedRedirectUris.length === 0) {
    // Nothing was captured, so nothing diverges: registering our own callback
    // is not a substitution for a value we never had.
    return {
      registrationRedirectUris: [callbackUrl],
      authorizationRedirectUri: callbackUrl,
      divergences,
    };
  }

  // Captured order first, ours appended. Deduped only against an exact match:
  // if the real client already registers this very URL there is nothing to add
  // and nothing to declare.
  const alreadyPresent = capturedRedirectUris.includes(callbackUrl);
  const registrationRedirectUris = alreadyPresent
    ? [...capturedRedirectUris]
    : [...capturedRedirectUris, callbackUrl];

  if (!alreadyPresent) {
    divergences.push({
      kind: "redirect-uri-appended",
      detail:
        `registration adds MCPJam's callback to the captured redirect_uris so the ` +
        `authorization code can be received and exchanged; the captured list is ` +
        `otherwise replayed in order`,
      requested: capturedRedirectUris.join(" "),
      used: registrationRedirectUris.join(" "),
    });
  }

  return {
    registrationRedirectUris,
    authorizationRedirectUri: callbackUrl,
    divergences,
  };
}

/**
 * Is this registration response a STRUCTURED RFC 7591 `invalid_redirect_uri`?
 *
 * Deliberately narrow. Retrying registration creates a second client on the
 * authorization server, so the trigger must be the server explicitly naming
 * this error in the documented field — never a substring match on prose, a
 * generic 4xx, a timeout, or a body that failed to parse. Anything else is an
 * unrelated failure that a retry would neither diagnose nor fix.
 */
export function isInvalidRedirectUriRejection(response: {
  status: number;
  body: unknown;
}): boolean {
  // Exactly 400. RFC 7591 §3.2.2 defines this error response as a 400, so any
  // other status carrying the string is a different failure wearing the same
  // word — an auth, routing, or rate-limit rejection must never spend the
  // one retry and create a second client.
  if (response.status !== 400) return false;
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as { error?: unknown }).error === "invalid_redirect_uri";
}
