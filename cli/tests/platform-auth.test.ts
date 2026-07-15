import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readStoredAuth,
  writeStoredAuth,
  type StoredPlatformAuth,
} from "../src/lib/auth-store.js";
import { CliError } from "../src/lib/output.js";
import {
  getOAuthAccessToken,
  resolvePlatformCredential,
  runPlatformLogin,
} from "../src/lib/platform-auth.js";

const NOW = 1_750_000_000_000;

async function tempAuthFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  return path.join(directory, "auth.json");
}

function storedAuth(
  tokenEndpoint: string,
  overrides: Partial<StoredPlatformAuth> = {},
): StoredPlatformAuth {
  return {
    version: 1,
    issuer: "https://login.example.com",
    clientId: "client_123",
    tokenEndpoint,
    accessToken: "stored-access",
    refreshToken: "stored-refresh",
    expiresAt: NOW + 60 * 60 * 1000,
    ...overrides,
  };
}

type FixtureRequest = {
  method: string;
  path: string;
  body: URLSearchParams;
};

/**
 * In-process stand-in for the hosted auth bridge + AuthKit: serves the CLI
 * auth config, accepts token exchanges, and lets openUrl play the browser.
 */
async function startAuthFixture(options: {
  tokenResponses?: Array<Record<string, unknown>>;
  configStatus?: number;
}): Promise<{
  origin: string;
  requests: FixtureRequest[];
  close: () => Promise<void>;
}> {
  const requests: FixtureRequest[] = [];
  const tokenResponses = [...(options.tokenResponses ?? [])];

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", origin);
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      body: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
    });

    if (url.pathname === "/api/cli/auth/config") {
      res.statusCode = options.configStatus ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          (options.configStatus ?? 200) === 200
            ? {
                issuer: origin,
                clientId: "client_123",
                authStartUrl: `${origin}/api/cli/auth/start`,
                tokenEndpoint: `${origin}/oauth2/token`,
                redirectUri: `${origin}/api/cli/auth/callback`,
                scope: "openid profile email offline_access",
              }
            : { code: "FEATURE_NOT_SUPPORTED", message: "disabled" },
        ),
      );
      return;
    }

    if (url.pathname === "/oauth2/token") {
      const next = tokenResponses.shift() ?? {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      };
      res.statusCode = typeof next.__status === "number" ? next.__status : 200;
      res.setHeader("content-type", "application/json");
      const { __status: _ignored, ...body } = next;
      res.end(JSON.stringify(body));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Plays the browser: follows the start URL by hitting the CLI loopback with a code. */
function browserSimulator(code = "auth-code-1"): (url: string) => Promise<void> {
  return async (startUrl: string) => {
    const parsed = new URL(startUrl);
    const loopback = new URL(parsed.searchParams.get("redirect_uri")!);
    loopback.searchParams.set("code", code);
    loopback.searchParams.set("state", parsed.searchParams.get("state")!);
    const response = await fetch(loopback);
    await response.text();
  };
}

test("resolvePlatformCredential prefers the --api-key flag", async () => {
  const credential = resolvePlatformCredential(
    { apiKey: "sk_flag" },
    { env: { MCPJAM_API_KEY: "sk_env" } },
  );

  assert.equal(credential.kind, "api-key");
  assert.equal(await credential.getAuth(), "sk_flag");
});

test("resolvePlatformCredential hard-errors on an explicit legacy key", () => {
  assert.throws(
    () => resolvePlatformCredential({ apiKey: "mcpjam_legacy" }, { env: {} }),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "USAGE_ERROR" &&
      error.message.includes("sk_"),
  );
});

test("resolvePlatformCredential uses MCPJAM_API_KEY when no flag is given", async () => {
  const credential = resolvePlatformCredential(
    {},
    { env: { MCPJAM_API_KEY: "sk_env" } },
  );

  assert.equal(credential.kind, "api-key");
  assert.equal(await credential.getAuth(), "sk_env");
});

test("resolvePlatformCredential warns on a legacy env key and falls through to stored OAuth", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(storedAuth("https://unused.example.com"), authFilePath);
  const warnings: string[] = [];

  const credential = resolvePlatformCredential(
    {},
    {
      env: { MCPJAM_API_KEY: "mcpjam_legacy" },
      authFilePath,
      now: () => NOW,
      warn: (message) => warnings.push(message),
    },
  );

  assert.equal(credential.kind, "oauth");
  assert.equal(await credential.getAuth(), "stored-access");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy mcpjam_/i);
});

test("getOAuthAccessToken errors when not logged in", async () => {
  const authFilePath = await tempAuthFile();

  await assert.rejects(
    getOAuthAccessToken({ authFilePath, now: () => NOW }),
    (error: unknown) =>
      error instanceof CliError && /not logged in/i.test(error.message),
  );
});

test("getOAuthAccessToken returns the stored token while fresh", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(storedAuth("https://unused.example.com"), authFilePath);

  assert.equal(
    await getOAuthAccessToken({ authFilePath, now: () => NOW }),
    "stored-access",
  );
});

test("getOAuthAccessToken refreshes within 60s of expiry and persists rotation", async () => {
  const fixture = await startAuthFixture({
    tokenResponses: [
      { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 1800 },
    ],
  });
  try {
    const authFilePath = await tempAuthFile();
    await writeStoredAuth(
      storedAuth(`${fixture.origin}/oauth2/token`, {
        expiresAt: NOW + 30_000,
      }),
      authFilePath,
    );

    const token = await getOAuthAccessToken({ authFilePath, now: () => NOW });

    assert.equal(token, "rotated-access");
    const persisted = readStoredAuth(authFilePath);
    assert.equal(persisted?.accessToken, "rotated-access");
    assert.equal(persisted?.refreshToken, "rotated-refresh");
    // The rotated expiry is computed from the injected clock, so it is
    // exactly NOW + expires_in.
    assert.equal(persisted?.expiresAt, NOW + 1800 * 1000);

    const tokenRequest = fixture.requests.find((r) => r.path === "/oauth2/token");
    assert.equal(tokenRequest?.body.get("grant_type"), "refresh_token");
    assert.equal(tokenRequest?.body.get("refresh_token"), "stored-refresh");
    assert.equal(tokenRequest?.body.get("client_id"), "client_123");
  } finally {
    await fixture.close();
  }
});

test("getOAuthAccessToken errors when expired without a refresh token", async () => {
  const authFilePath = await tempAuthFile();
  const expired = storedAuth("https://unused.example.com", {
    expiresAt: NOW - 1,
  });
  delete expired.refreshToken;
  await writeStoredAuth(expired, authFilePath);

  await assert.rejects(
    getOAuthAccessToken({ authFilePath, now: () => NOW }),
    (error: unknown) =>
      error instanceof CliError && /login expired/i.test(error.message),
  );
});

test("runPlatformLogin completes the PKCE flow end to end and stores tokens", async () => {
  const fixture = await startAuthFixture({});
  try {
    const authFilePath = await tempAuthFile();

    const result = await runPlatformLogin(
      { origin: fixture.origin, apiUrl: `${fixture.origin}/api/v1` },
      {
        openUrl: browserSimulator(),
        authFilePath,
        timeoutMs: 10_000,
        now: () => NOW,
      },
    );

    assert.equal(result.authFilePath, authFilePath);
    const persisted = readStoredAuth(authFilePath);
    assert.equal(persisted?.accessToken, "new-access");
    assert.equal(persisted?.refreshToken, "new-refresh");
    assert.equal(persisted?.expiresAt, NOW + 3600 * 1000);
    assert.equal(persisted?.tokenEndpoint, `${fixture.origin}/oauth2/token`);
    // The API base URL of the deployment is stored with the session so later
    // cloud commands default to it instead of prod.
    assert.equal(persisted?.apiUrl, `${fixture.origin}/api/v1`);

    const tokenRequest = fixture.requests.find((r) => r.path === "/oauth2/token");
    assert.equal(tokenRequest?.body.get("grant_type"), "authorization_code");
    assert.equal(tokenRequest?.body.get("code"), "auth-code-1");
    // The exchange presents the HOSTED redirect URI registered with AuthKit,
    // not the loopback the code was forwarded to.
    assert.equal(
      tokenRequest?.body.get("redirect_uri"),
      `${fixture.origin}/api/cli/auth/callback`,
    );
    assert.ok((tokenRequest?.body.get("code_verifier")?.length ?? 0) >= 43);
  } finally {
    await fixture.close();
  }
});

test("runPlatformLogin fails actionably when no refresh token is returned", async () => {
  const fixture = await startAuthFixture({
    tokenResponses: [{ access_token: "only-access", expires_in: 3600 }],
  });
  try {
    const authFilePath = await tempAuthFile();

    await assert.rejects(
      runPlatformLogin(
        { origin: fixture.origin, apiUrl: `${fixture.origin}/api/v1` },
        {
          openUrl: browserSimulator(),
          authFilePath,
          timeoutMs: 10_000,
        },
      ),
      (error: unknown) =>
        error instanceof CliError && /refresh token/i.test(error.message),
    );
    assert.equal(readStoredAuth(authFilePath), null);
  } finally {
    await fixture.close();
  }
});

test("runPlatformLogin reports a disabled hosted bridge actionably", async () => {
  const fixture = await startAuthFixture({ configStatus: 501 });
  try {
    await assert.rejects(
      runPlatformLogin(
        { origin: fixture.origin, apiUrl: `${fixture.origin}/api/v1` },
        { timeoutMs: 1000 },
      ),
      (error: unknown) =>
        error instanceof CliError &&
        /not enabled/i.test(error.message) &&
        /api-key/i.test(error.message),
    );
  } finally {
    await fixture.close();
  }
});
