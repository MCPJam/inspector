/**
 * A 401 is a setup gap, not a server fault.
 *
 * Answering a request without credentials with HTTP 401 is what an
 * OAuth-protected server must do, and a rejected token is almost always an
 * expired or wrong login. Either way the server did nothing wrong, so every
 * check the 401 stopped is gray "Not run" and costs no point. The plain fix
 * depends on whether this run sent any credentials at all.
 *
 * The `authorizationRequired` marker stays alongside, so a UI can still offer
 * the reconnect.
 */

import { authorizationRequiredDetails } from "./conformance-authorization.js";
import { needsSetupDetails } from "./conformance-input.js";
import { hasConnectionCredentials } from "./server-doctor-core.js";

export const LOGIN_NEEDED_MESSAGE =
  "This server needs a login, so this check could not run. Log in, then run again.";

export const LOGIN_REJECTED_MESSAGE =
  "The server rejected your login (HTTP 401), so this check could not run. Log in again, then run again.";

/** Whatever a run might have sent to authenticate. */
export interface ConformanceCredentialSource {
  accessToken?: string;
  headers?: HeadersInit | Record<string, string>;
  refreshToken?: string;
  authProvider?: unknown;
}

/** Credentials as a server config carries them (`requestInit.headers`). */
export function credentialsFromServerConfig(config: unknown):
  | ConformanceCredentialSource
  | undefined {
  if (!config || typeof config !== "object") return undefined;
  const value = config as {
    accessToken?: unknown;
    requestInit?: { headers?: HeadersInit };
    refreshToken?: unknown;
    authProvider?: unknown;
  };
  return {
    accessToken:
      typeof value.accessToken === "string" ? value.accessToken : undefined,
    headers: value.requestInit?.headers,
    refreshToken:
      typeof value.refreshToken === "string" ? value.refreshToken : undefined,
    authProvider: value.authProvider,
  };
}

/** True when the run sent a token, an Authorization header, or a way to get one. */
export function sentCredentials(
  source: ConformanceCredentialSource | undefined,
): boolean {
  if (!source) return false;
  return hasConnectionCredentials({
    url: "",
    accessToken: source.accessToken,
    requestInit: { headers: source.headers as HeadersInit | undefined },
    refreshToken: source.refreshToken,
    authProvider: source.authProvider,
  });
}

/** `details` for a check a 401 stopped: gray "Not run", with the right fix. */
export function loginRequiredDetails(
  error: unknown,
  source: ConformanceCredentialSource | undefined,
): Record<string, unknown> {
  return {
    ...authorizationRequiredDetails(error),
    ...needsSetupDetails(
      "login",
      sentCredentials(source) ? LOGIN_REJECTED_MESSAGE : LOGIN_NEEDED_MESSAGE,
    ),
  };
}
