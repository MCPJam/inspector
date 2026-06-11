import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import cliAuthRoutes from "../index.js";
import {
  CLI_AUTH_STATE_TTL_MS,
  isAllowedLoopbackRedirect,
  signCliAuthState,
  verifyCliAuthState,
} from "../state.js";

const SECRET = "test-secret";
const PUBLIC_ORIGIN = "https://app.example.com";
const CLIENT_ID = "client_01TESTTESTTESTTESTTESTTEST";
const LOOPBACK = "http://127.0.0.1:43217/callback";
// 43 unreserved chars — the minimum valid S256 challenge length.
const CHALLENGE = "a".repeat(43);

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/cli/auth", cliAuthRoutes);
  return app;
}

function startUrl(
  params: Record<string, string | undefined> = {}
): string {
  const url = new URL("http://inspector.test/api/cli/auth/start");
  const defaults: Record<string, string> = {
    redirect_uri: LOOPBACK,
    state: "cli-state-123",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.pathname + url.search;
}

const MANAGED_ENV_KEYS = [
  "CLI_AUTH_STATE_SECRET",
  "CLI_AUTH_PUBLIC_ORIGIN",
  "WORKOS_CLIENT_ID",
  "VITE_WORKOS_CLIENT_ID",
  "AUTHKIT_DOMAIN",
] as const;
const originalEnv: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
  process.env.CLI_AUTH_STATE_SECRET = SECRET;
  process.env.CLI_AUTH_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  process.env.WORKOS_CLIENT_ID = CLIENT_ID;
  process.env.AUTHKIT_DOMAIN = "login.example.com";
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isAllowedLoopbackRedirect", () => {
  it.each([
    ["http://127.0.0.1:8123/callback", true],
    ["http://localhost:8123/cb", true],
    ["http://127.0.0.1/callback", true],
    ["https://127.0.0.1:8123/callback", false], // https loopback is not how the CLI listens
    ["http://127.0.0.1.evil.com/callback", false],
    ["http://evil.com/callback", false],
    ["https://evil.com/callback", false],
    ["http://user:pass@127.0.0.1:8123/callback", false],
    ["not-a-url", false],
    ["", false],
  ])("%s -> %s", (uri, expected) => {
    expect(isAllowedLoopbackRedirect(uri)).toBe(expected);
  });
});

describe("signed state", () => {
  it("round-trips a valid payload", () => {
    const payload = {
      cliRedirectUri: LOOPBACK,
      cliState: "abc",
      exp: Date.now() + CLI_AUTH_STATE_TTL_MS,
    };
    const token = signCliAuthState(payload, SECRET);

    expect(verifyCliAuthState(token, SECRET)).toEqual(payload);
  });

  it("rejects tampered, wrong-key, expired, and non-loopback states", () => {
    const exp = Date.now() + CLI_AUTH_STATE_TTL_MS;
    const valid = signCliAuthState(
      { cliRedirectUri: LOOPBACK, cliState: "abc", exp },
      SECRET
    );

    expect(verifyCliAuthState(`${valid}x`, SECRET)).toBeNull();
    expect(verifyCliAuthState(valid, "other-secret")).toBeNull();
    expect(verifyCliAuthState("garbage", SECRET)).toBeNull();
    expect(
      verifyCliAuthState(
        signCliAuthState(
          { cliRedirectUri: LOOPBACK, cliState: "abc", exp: Date.now() - 1 },
          SECRET
        ),
        SECRET
      )
    ).toBeNull();
    // Even a correctly signed state with a non-loopback target is rejected
    // at verification time (defense in depth for the callback redirect).
    expect(
      verifyCliAuthState(
        signCliAuthState(
          { cliRedirectUri: "https://evil.com/cb", cliState: "abc", exp },
          SECRET
        ),
        SECRET
      )
    ).toBeNull();
  });
});

describe("GET /api/cli/auth (not configured)", () => {
  it.each(["/config", `${startUrl()}`, "/callback?state=x"])(
    "answers 501 on %s when the secret is missing",
    async (path) => {
      delete process.env.CLI_AUTH_STATE_SECRET;
      const response = await makeApp().request(
        path.startsWith("/api") ? path : `/api/cli/auth${path}`
      );

      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({
        code: "FEATURE_NOT_SUPPORTED",
      });
    }
  );

  it("answers 501 when the public origin is missing", async () => {
    delete process.env.CLI_AUTH_PUBLIC_ORIGIN;
    const response = await makeApp().request("/api/cli/auth/config");

    expect(response.status).toBe(501);
  });
});

describe("GET /api/cli/auth/config", () => {
  it("returns the public OAuth metadata from explicit configuration", async () => {
    const response = await makeApp().request("/api/cli/auth/config");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: "https://login.example.com",
      clientId: CLIENT_ID,
      authStartUrl: `${PUBLIC_ORIGIN}/api/cli/auth/start`,
      tokenEndpoint: "https://login.example.com/oauth2/token",
      redirectUri: `${PUBLIC_ORIGIN}/api/cli/auth/callback`,
      scope: "openid profile email offline_access",
    });
  });
});

describe("GET /api/cli/auth/start", () => {
  it("redirects to the AuthKit authorize endpoint with a signed state", async () => {
    const response = await makeApp().request(startUrl());

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://login.example.com");
    expect(location.pathname).toBe("/oauth2/authorize");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_ORIGIN}/api/cli/auth/callback`
    );
    expect(location.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toContain("offline_access");

    const signedState = location.searchParams.get("state")!;
    expect(verifyCliAuthState(signedState, SECRET)).toMatchObject({
      cliRedirectUri: LOOPBACK,
      cliState: "cli-state-123",
    });
  });

  it.each([
    ["non-loopback redirect", { redirect_uri: "https://evil.com/cb" }],
    ["loopback-prefixed host", { redirect_uri: "http://127.0.0.1.evil.com/cb" }],
    ["embedded credentials", { redirect_uri: "http://u:p@127.0.0.1:1/cb" }],
    ["missing state", { state: "" }],
    ["bad challenge", { code_challenge: "too-short" }],
    ["bad method", { code_challenge_method: "plain" }],
  ])("rejects %s with 400", async (_label, params) => {
    const response = await makeApp().request(startUrl(params));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("GET /api/cli/auth/callback", () => {
  function signedState(
    overrides: Partial<Parameters<typeof signCliAuthState>[0]> = {}
  ): string {
    return signCliAuthState(
      {
        cliRedirectUri: LOOPBACK,
        cliState: "cli-state-123",
        exp: Date.now() + CLI_AUTH_STATE_TTL_MS,
        ...overrides,
      },
      SECRET
    );
  }

  it("forwards the code to the loopback with the original CLI state", async () => {
    const response = await makeApp().request(
      `/api/cli/auth/callback?code=auth-code-1&state=${encodeURIComponent(signedState())}`
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK);
    expect(location.searchParams.get("code")).toBe("auth-code-1");
    expect(location.searchParams.get("state")).toBe("cli-state-123");
  });

  it("forwards provider errors instead of a code", async () => {
    const response = await makeApp().request(
      `/api/cli/auth/callback?error=access_denied&error_description=nope&state=${encodeURIComponent(signedState())}`
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe("nope");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it.each([
    ["missing state", "code=x"],
    ["tampered state", `code=x&state=${encodeURIComponent("tampered.token")}`],
  ])("answers 400 (never redirects) for %s", async (_label, query) => {
    const response = await makeApp().request(`/api/cli/auth/callback?${query}`);

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("answers 400 for an expired state", async () => {
    const expired = signedState({ exp: Date.now() - 1 });
    const response = await makeApp().request(
      `/api/cli/auth/callback?code=x&state=${encodeURIComponent(expired)}`
    );

    expect(response.status).toBe(400);
  });

  it("answers 400 when the callback has neither code nor error", async () => {
    const response = await makeApp().request(
      `/api/cli/auth/callback?state=${encodeURIComponent(signedState())}`
    );

    expect(response.status).toBe(400);
  });
});
