import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  writeStoredAuth,
  type StoredPlatformAuth,
} from "../src/lib/auth-store.js";
import { CliError } from "../src/lib/output.js";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import {
  buildPlatformClient,
  resolveCliDeployment,
  toCliError,
} from "../src/lib/platform-client.js";

const NOW = 1_750_000_000_000;

async function tempAuthFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  return path.join(directory, "auth.json");
}

function storedAuth(
  overrides: Partial<StoredPlatformAuth> = {},
): StoredPlatformAuth {
  return {
    version: 1,
    issuer: "https://login.example.com",
    clientId: "client_123",
    tokenEndpoint: "https://login.example.com/oauth2/token",
    accessToken: "stored-access",
    refreshToken: "stored-refresh",
    expiresAt: NOW + 60 * 60 * 1000,
    ...overrides,
  };
}

/** Records request URLs and answers every call with a minimal /me payload. */
function captureFetch(requested: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    requested.push(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    return new Response(
      JSON.stringify({ id: "user-1", email: "dev@example.com", name: "Dev" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

const isUsageError = (error: unknown) =>
  error instanceof CliError && error.code === "USAGE_ERROR";

test("resolveCliDeployment prefers the flag over env over the default", () => {
  const apiUrlOf = (apiUrl: string | undefined, env: NodeJS.ProcessEnv) =>
    resolveCliDeployment({ apiUrl, credential: "api-key" }, { env }).apiUrl;
  assert.equal(
    apiUrlOf("https://flag.example.com/api/v1", {
      MCPJAM_API_URL: "https://env.example.com/api/v1",
    }),
    "https://flag.example.com/api/v1",
  );
  assert.equal(
    apiUrlOf(undefined, { MCPJAM_API_URL: "https://env.example.com/api/v1" }),
    "https://env.example.com/api/v1",
  );
  assert.equal(apiUrlOf(undefined, {}), "https://app.mcpjam.com/api/v1");
});

test("an invalid --api-url hard-errors instead of falling back to prod", () => {
  for (const apiUrl of ["staging.mcpjam.com", "not a url", "ftp://example.com/api"]) {
    assert.throws(
      () => resolveCliDeployment({ apiUrl, credential: "api-key" }, { env: {} }),
      (error: unknown) =>
        isUsageError(error) &&
        error instanceof CliError &&
        error.message.startsWith("Invalid --api-url value"),
    );
  }
});

test("an invalid MCPJAM_API_URL hard-errors too", () => {
  assert.throws(
    () =>
      resolveCliDeployment(
        { credential: "api-key" },
        { env: { MCPJAM_API_URL: "nope" } },
      ),
    isUsageError,
  );
});

test("MCPJAM_API_URL and MCPJAM_BASE_URL naming two servers exit 2", () => {
  assert.throws(
    () =>
      resolveCliDeployment(
        { credential: "api-key" },
        {
          env: {
            MCPJAM_API_URL: "https://a.example.com/api/v1",
            MCPJAM_BASE_URL: "https://b.example.com",
          },
        },
      ),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "DEPLOYMENT_CONFLICT" &&
      error.exitCode === 2,
  );
});

test("buildPlatformClient defaults to the API URL stored with the login", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(
    storedAuth({ apiUrl: "https://staging.mcpjam.com/api/v1" }),
    authFilePath,
  );
  const requested: string[] = [];

  const { client, credentialKind } = buildPlatformClient(
    {},
    { env: {}, authFilePath, fetchFn: captureFetch(requested), now: () => NOW },
  );
  await client.getMe();

  assert.equal(credentialKind, "oauth");
  assert.equal(requested.length, 1);
  assert.ok(
    requested[0].startsWith("https://staging.mcpjam.com/api/v1/"),
    `expected the stored deployment to be called, got ${requested[0]}`,
  );
});

test("a saved login is never sent to another --api-url", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(
    storedAuth({ apiUrl: "https://staging.mcpjam.com/api/v1" }),
    authFilePath,
  );
  const requested: string[] = [];

  assert.throws(
    () =>
      buildPlatformClient(
        { apiUrl: "https://other.example.com/api/v1" },
        {
          env: {},
          authFilePath,
          fetchFn: captureFetch(requested),
          now: () => NOW,
        },
      ),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "LOGIN_DEPLOYMENT_MISMATCH" &&
      error.exitCode === 3 &&
      error.message ===
        "Your saved login is for https://staging.mcpjam.com/api/v1; this command targets https://other.example.com/api/v1. Run `mcpjam cloud login --api-url https://other.example.com/api/v1` to sign in there, or use an API key for that server.",
  );
  assert.deepEqual(requested, []);
});

test("a redirect from the API is refused and exits 2", async () => {
  const authFilePath = await tempAuthFile();
  const requested: string[] = [];
  const redirecting = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(null, {
      status: 307,
      headers: { location: "https://elsewhere.example.com/collect" },
    });
  }) as typeof fetch;
  const { client } = buildPlatformClient(
    { apiKey: "sk_test", apiUrl: "https://a.example.com/api/v1" },
    { env: {}, authFilePath, fetchFn: redirecting, now: () => NOW },
  );

  const error = toCliError(await client.getMe().catch((caught) => caught));
  assert.equal(error.code, "BACKEND_REDIRECT_REFUSED");
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /redirect to https:\/\/elsewhere\.example\.com/);
  assert.equal(requested.length, 1);
});

test("an sk_ API key does not inherit the stored login's URL", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(
    storedAuth({ apiUrl: "https://staging.mcpjam.com/api/v1" }),
    authFilePath,
  );
  const requested: string[] = [];

  const { client, credentialKind } = buildPlatformClient(
    { apiKey: "sk_test" },
    { env: {}, authFilePath, fetchFn: captureFetch(requested), now: () => NOW },
  );
  await client.getMe();

  // The stored URL belongs to the stored OAuth session; an explicit key
  // without an explicit URL targets the default deployment.
  assert.equal(credentialKind, "api-key");
  assert.ok(requested[0].startsWith("https://app.mcpjam.com/api/v1/"));
});

test("a stored login without apiUrl still defaults to prod", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(storedAuth(), authFilePath);
  const requested: string[] = [];

  const { client } = buildPlatformClient(
    {},
    { env: {}, authFilePath, fetchFn: captureFetch(requested), now: () => NOW },
  );
  await client.getMe();

  assert.ok(requested[0].startsWith("https://app.mcpjam.com/api/v1/"));
});

test("a usage-limit refusal keeps its code and exit, and carries when to retry", () => {
  const error = toCliError(
    new PlatformApiError("Daily generation quota reached.", "RATE_LIMITED", {
      status: 429,
      retryAfter: 120,
      details: {
        code: "generation_rate_limited",
        gatedBy: "organization",
        canTopUp: false,
      },
    }),
  );
  // Not an auth or credit failure: same wire code, same exit code.
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.exitCode, 1);
  assert.equal(
    error.message,
    "Daily generation quota reached. Retry after 120s, not sooner. This is a usage limit: topping up credits does not lift it.",
  );
  assert.deepEqual((error.details as Record<string, unknown>).refusal, {
    status: 429,
    code: "RATE_LIMITED",
    reason: "generation_rate_limited",
    gatedBy: "organization",
    canTopUp: false,
    retryAfterSeconds: 120,
  });
});

test("a failing request's id rides in details, beside the server's own", () => {
  const error = toCliError(
    new PlatformApiError("Something broke.", "INTERNAL_ERROR", {
      status: 500,
      details: { reason: "upstream" },
      requestId: "req_0123456789abcdef",
    }),
  );
  assert.equal(error.code, "INTERNAL_ERROR");
  // Prefix only: a platform fault with a request id also earns the report
  // hint, pinned in full below.
  assert.match(error.message, /^Something broke\./);
  assert.deepEqual(error.details, {
    reason: "upstream",
    requestId: "req_0123456789abcdef",
  });
});

test("a request id with no server details still lands in details", () => {
  const error = toCliError(
    new PlatformApiError("Not found.", "NOT_FOUND", {
      status: 404,
      requestId: "req_0123456789abcdef",
    }),
  );
  assert.deepEqual(error.details, { requestId: "req_0123456789abcdef" });
});

test("a refusal carries its request id next to the retry guidance", () => {
  const error = toCliError(
    new PlatformApiError("Slow down.", "RATE_LIMITED", {
      status: 429,
      retryAfter: 30,
      requestId: "req_0123456789abcdef",
    }),
  );
  const details = error.details as Record<string, unknown>;
  assert.equal(details.requestId, "req_0123456789abcdef");
  assert.deepEqual(details.refusal, {
    status: 429,
    code: "RATE_LIMITED",
    retryAfterSeconds: 30,
  });
});

test("an error without a request id keeps its details untouched", () => {
  // Client-side failures never reached the API; nothing is invented.
  const error = toCliError(
    new PlatformApiError("Failed to reach the MCPJam API.", "NETWORK_ERROR", {
      status: 0,
    }),
  );
  assert.equal(error.details, undefined);
});

test("a platform fault with a request id says how to report it", () => {
  const error = toCliError(
    new PlatformApiError("Something broke.", "INTERNAL_ERROR", {
      status: 500,
      requestId: "req_0123456789abcdef",
    }),
    { command: "cloud eval run" },
  );
  assert.equal(
    error.message,
    'Something broke. Report it: `mcpjam cloud feedback --kind bug --request-id req_0123456789abcdef --summary "…"`',
  );
});

test("a missing capability suggests the missing_capability kind", () => {
  const error = toCliError(
    new PlatformApiError(
      "This server does not support tasks.",
      "FEATURE_NOT_SUPPORTED",
      { status: 422, requestId: "req_0123456789abcdef" },
    ),
  );
  assert.match(error.message, /--kind missing_capability --request-id/);
});

test("no report hint on a gateway failure, a client error, or without a request id", () => {
  for (const [status, code] of [
    [502, "INTERNAL_ERROR"],
    [503, "INTERNAL_ERROR"],
    [504, "INTERNAL_ERROR"],
    [404, "NOT_FOUND"],
    [400, "VALIDATION_ERROR"],
  ] as const) {
    const error = toCliError(
      new PlatformApiError("Nope.", code, {
        status,
        requestId: "req_0123456789abcdef",
      }),
    );
    assert.equal(error.message, "Nope.", `${status} ${code}`);
  }
  const withoutId = toCliError(
    new PlatformApiError("Something broke.", "INTERNAL_ERROR", {
      status: 500,
    }),
  );
  assert.equal(withoutId.message, "Something broke.");
});

test("no report hint on the command that files reports", () => {
  const error = toCliError(
    new PlatformApiError("Something broke.", "INTERNAL_ERROR", {
      status: 500,
      requestId: "req_0123456789abcdef",
    }),
    { command: "cloud feedback" },
  );
  assert.equal(error.message, "Something broke.");
});
