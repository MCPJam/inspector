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
import {
  buildPlatformClient,
  resolvePlatformBaseUrl,
  resolvePlatformOrigin,
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

test("resolvePlatformBaseUrl prefers the flag over env over the default", () => {
  assert.equal(
    resolvePlatformBaseUrl(
      { apiUrl: "https://flag.example.com/api/v1" },
      { MCPJAM_API_URL: "https://env.example.com/api/v1" },
    ),
    "https://flag.example.com/api/v1",
  );
  assert.equal(
    resolvePlatformBaseUrl(
      {},
      { MCPJAM_API_URL: "https://env.example.com/api/v1" },
    ),
    "https://env.example.com/api/v1",
  );
  assert.equal(
    resolvePlatformBaseUrl({}, {}),
    "https://app.mcpjam.com/api/v1",
  );
});

test("an invalid --api-url hard-errors instead of falling back to prod", () => {
  assert.throws(
    () => resolvePlatformBaseUrl({ apiUrl: "staging.mcpjam.com" }, {}),
    isUsageError,
  );
  assert.throws(
    () => resolvePlatformOrigin({ apiUrl: "not a url" }, {}),
    isUsageError,
  );
  // Non-http(s) schemes are also explicit mistakes, not prod logins.
  assert.throws(
    () => resolvePlatformBaseUrl({ apiUrl: "ftp://example.com/api" }, {}),
    isUsageError,
  );
});

test("an invalid MCPJAM_API_URL hard-errors too", () => {
  assert.throws(
    () => resolvePlatformBaseUrl({}, { MCPJAM_API_URL: "nope" }),
    isUsageError,
  );
});

test("resolvePlatformOrigin strips the API path from the base URL", () => {
  assert.equal(
    resolvePlatformOrigin({ apiUrl: "https://staging.mcpjam.com/api/v1" }, {}),
    "https://staging.mcpjam.com",
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

test("an explicit --api-url overrides the stored login URL", async () => {
  const authFilePath = await tempAuthFile();
  await writeStoredAuth(
    storedAuth({ apiUrl: "https://staging.mcpjam.com/api/v1" }),
    authFilePath,
  );
  const requested: string[] = [];

  const { client } = buildPlatformClient(
    { apiUrl: "https://other.example.com/api/v1" },
    { env: {}, authFilePath, fetchFn: captureFetch(requested), now: () => NOW },
  );
  await client.getMe();

  assert.ok(requested[0].startsWith("https://other.example.com/api/v1/"));
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
