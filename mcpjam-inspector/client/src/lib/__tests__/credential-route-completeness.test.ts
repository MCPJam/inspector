import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../app-routes";
import {
  CREDENTIAL_ROUTES,
  isReplayBlockedLocation,
  matchCredentialPath,
} from "../../../../shared/credential-urls";

/**
 * Every app route parameter that LOOKS like a secret is either a registered
 * credential route (`shared/credential-urls.ts`) or listed here with the
 * reason it is not one; every callback route blocks replay.
 *
 * A share link is a credential in a URL, and every telemetry sink scrubs URLs
 * from ONE registry. A new route that carries a token and is not registered
 * would ship that token in `$current_url`, in Sentry transaction names and in
 * replays. The server's twin covers `/api/web`.
 */
const SECRET_LOOKING_PARAM = /token|secret|code|key|sig|cred/i;

const NOT_CREDENTIALS = new Map<string, string>([]);

/** Routes that land with secrets in the QUERY: replay must be blocked there. */
const CALLBACK_PATHS = [
  "callback",
  "oauth/callback/*",
  "settings/integrations/github/callback",
];

function concrete(path: string): string {
  return `/${path.replace(/:([A-Za-z0-9_]+)/g, "PARAM_$1").replace(/\*$/, "x")}`;
}

const secretLooking = APP_ROUTES.map((route) => route.path).filter((path) =>
  (path.match(/:([A-Za-z0-9_]+)/g) ?? []).some((param) =>
    SECRET_LOOKING_PARAM.test(param.slice(1)),
  ),
);

describe("credential route completeness (APP_ROUTES)", () => {
  it("finds the routes it is meant to police", () => {
    expect(secretLooking).toEqual(
      expect.arrayContaining([
        "results/:runToken",
        "bench/results/:secret",
        "conformance/shared/:token",
        "evals/shared/:token",
      ]),
    );
  });

  it.each(secretLooking.map((path) => [path]))(
    "%s is registered or allow-listed",
    (path) => {
      if (NOT_CREDENTIALS.has(path)) return;
      const match = matchCredentialPath(concrete(path));
      expect(
        match,
        `${path} has a secret-looking parameter. Register it in shared/credential-urls.ts (CREDENTIAL_ROUTES) or add it to NOT_CREDENTIALS with the reason it is not a credential.`,
      ).not.toBeNull();
      expect(match?.secret?.startsWith("PARAM_")).toBe(true);
      expect(
        SECRET_LOOKING_PARAM.test(match?.secret?.slice("PARAM_".length) ?? ""),
      ).toBe(true);
    },
  );

  it.each(CALLBACK_PATHS.map((path) => [path]))(
    "callback route %s is in the table and blocks replay",
    (path) => {
      expect(APP_ROUTES.map((route) => route.path)).toContain(path);
      expect(isReplayBlockedLocation({ pathname: concrete(path) })).toBe(true);
    },
  );

  it("every registered page route the router serves is in the table", () => {
    // Tester links and the handoff page are matched outside the router
    // (`App` / `app-bootstrap`), so they are not expected here.
    const outsideRouter = new Set([
      "tester-link",
      "tester-link-legacy",
      "server-connection-claim",
      "local-access-link",
    ]);
    const paths = APP_ROUTES.map((route) => `/${route.path}`);
    for (const route of CREDENTIAL_ROUTES) {
      if (route.scope !== "page" || outsideRouter.has(route.id)) continue;
      const template = route.pattern.endsWith("*")
        ? `${route.pattern.slice(0, -1)}/*`
        : route.pattern;
      expect(paths, route.id).toContain(template);
    }
  });

  it("every allow-list entry still exists", () => {
    for (const path of NOT_CREDENTIALS.keys()) {
      expect(secretLooking).toContain(path);
    }
  });
});
