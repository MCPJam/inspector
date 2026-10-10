import { describe, expect, it } from "vitest";
import webRoutes from "../index.js";
import { matchCredentialPath } from "../../../../shared/credential-urls.js";

/**
 * Every `/api/web` route parameter that LOOKS like a secret is either a
 * registered credential route (`shared/credential-urls.ts`) or listed here
 * with the reason it is not one.
 *
 * Why this exists: a share link is a credential in a URL, and every
 * telemetry sink scrubs URLs from ONE registry. A route that mints a new
 * kind of link and is not registered there leaks its token into log lines,
 * Sentry transactions and relay payloads, and nothing would notice. This test
 * notices. The client's twin covers `APP_ROUTES`.
 */
const SECRET_LOOKING_PARAM = /token|secret|code|key|sig|cred/i;

const NOT_CREDENTIALS = new Map<string, string>([
  [
    "/api/web/api-keys/organization/:organizationId/:keyId",
    "the id of an API key record, used to revoke it; the key itself never appears in a URL",
  ],
]);

function concrete(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, "PARAM_$1");
}

describe("credential route completeness (/api/web)", () => {
  const secretLooking = webRoutes.routes
    .map((route) => `/api/web${route.path}`)
    .filter((path, index, all) => all.indexOf(path) === index)
    .filter((path) =>
      (path.match(/:([A-Za-z0-9_]+)/g) ?? []).some((param) =>
        SECRET_LOOKING_PARAM.test(param.slice(1)),
      ),
    );

  it("finds the routes it is meant to police", () => {
    // Non-vacuous: the three known credential APIs must be in the sweep.
    expect(secretLooking).toEqual(
      expect.arrayContaining([
        "/api/web/score/runs/:token",
        "/api/web/bench/results/:secret",
        "/api/web/conformance-shared/:token",
      ]),
    );
  });

  it.each(secretLooking.map((path) => [path]))(
    "%s is registered or allow-listed",
    (path) => {
      if (NOT_CREDENTIALS.has(path)) return;
      const match = matchCredentialPath(concrete(path));
      const secretParams = (path.match(/:([A-Za-z0-9_]+)/g) ?? [])
        .map((param) => param.slice(1))
        .filter((param) => SECRET_LOOKING_PARAM.test(param));
      expect(
        match,
        `${path} has a secret-looking parameter. Register it in shared/credential-urls.ts (CREDENTIAL_ROUTES) or add it to NOT_CREDENTIALS with the reason it is not a credential.`,
      ).not.toBeNull();
      expect(secretParams.map((param) => `PARAM_${param}`)).toContain(
        match?.secret,
      );
    },
  );

  it("every allow-list entry still exists", () => {
    for (const path of NOT_CREDENTIALS.keys()) {
      expect(secretLooking).toContain(path);
    }
  });
});
