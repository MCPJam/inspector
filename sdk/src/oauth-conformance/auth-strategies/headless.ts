import type {
  AuthorizationCodeResult,
  TrackedRequestFn,
} from "../types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectToCallback(targetUrl: string, redirectUrl: string): boolean {
  const target = new URL(targetUrl);
  const callback = new URL(redirectUrl);
  return target.origin === callback.origin && target.pathname === callback.pathname;
}

export interface HeadlessAuthorizationInput {
  authorizationUrl: string;
  redirectUrl: string;
  expectedState?: string;
  request: TrackedRequestFn;
}

export async function completeHeadlessAuthorization({
  authorizationUrl,
  redirectUrl,
  expectedState,
  request,
}: HeadlessAuthorizationInput): Promise<AuthorizationCodeResult> {
  let currentUrl = authorizationUrl;

  for (let hop = 0; hop < 10; hop += 1) {
    const response = await request(
      {
        method: "GET",
        url: currentUrl,
        headers: {},
      },
      { redirect: "manual" },
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(
          `Authorization redirect from ${currentUrl} did not include a Location header`,
        );
      }

      const nextUrl = new URL(location, currentUrl).toString();
      if (isRedirectToCallback(nextUrl, redirectUrl)) {
        const callbackUrl = new URL(nextUrl);
        const code = callbackUrl.searchParams.get("code");
        const returnedState = callbackUrl.searchParams.get("state") ?? undefined;

        if (!code) {
          throw new Error(
            "Authorization server redirected to the callback URL without a code parameter",
          );
        }

        if (expectedState && returnedState !== expectedState) {
          throw new Error(
            `Authorization state mismatch. Expected ${expectedState}, received ${returnedState ?? "missing"}`,
          );
        }

        return { code };
      }

      currentUrl = nextUrl;
      continue;
    }

    if (response.status === 200) {
      throw new Error(
        "Headless authorization requires auto-consent. The authorization endpoint returned a 200 response instead of redirecting back with a code.",
      );
    }

    throw new Error(
      `Authorization request failed with HTTP ${response.status} ${response.statusText}`,
    );
  }

  throw new Error("Authorization redirect loop exceeded 10 hops");
}
