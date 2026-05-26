import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConformanceResult, OAuthLoginResult } from "@mcpjam/sdk";
import {
  readCredentialsFile,
  redactCredentialsFromResult,
  resolveCredentialsFileAccessToken,
  resolveCredentialsFileAuth,
  writeCredentialsFile,
} from "../src/lib/credentials-file.js";
import { CliError } from "../src/lib/output.js";

const NOW = new Date("2026-04-26T12:00:00.000Z");

function createOAuthLoginResult(
  overrides: Partial<OAuthLoginResult> = {},
): OAuthLoginResult {
  return {
    ...overrides,
    completed: true,
    serverUrl: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    protocolMode: "auto",
    registrationMode: "auto",
    authMode: "interactive",
    redirectUrl: "https://app.example.com/callback",
    currentStep: "complete",
    authorizationPlan: {} as OAuthLoginResult["authorizationPlan"],
    credentials: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenType: "bearer",
      expiresIn: 3600,
      ...overrides.credentials,
    },
    state: {
      currentStep: "complete",
      httpHistory: [],
      infoLogs: [],
      nested: {
        accessToken: "nested-access-token",
      },
    } as unknown as OAuthLoginResult["state"],
  };
}

function createOAuthConformanceResult(
  overrides: Partial<ConformanceResult> = {},
): ConformanceResult {
  return {
    passed: true,
    serverUrl: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    steps: [],
    summary: "OAuth conformance passed",
    durationMs: 10,
    ...overrides,
    credentials: {
      accessToken: "conformance-access-token",
      refreshToken: "conformance-refresh-token",
      clientId: "conformance-client-id",
      clientSecret: "conformance-client-secret",
      tokenType: "Bearer",
      expiresIn: 1800,
      ...overrides.credentials,
    },
  };
}

async function writeCredentialsJson(contents: object): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-creds-test-"));
  const filePath = path.join(directory, "credentials.json");
  await writeFile(filePath, `${JSON.stringify(contents)}\n`, "utf8");
  return filePath;
}

test("writeCredentialsFile writes versioned JSON with secret-safe permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-creds-test-"));
  const filePath = path.join(directory, "credentials.json");

  const writtenPath = await writeCredentialsFile(
    filePath,
    createOAuthLoginResult(),
    NOW,
  );

  assert.equal(writtenPath, filePath);
  const fileMode = (await stat(filePath)).mode & 0o777;
  assert.equal(fileMode, 0o600);

  const payload = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(payload, {
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenType: "bearer",
    expiresAt: "2026-04-26T13:00:00.000Z",
    protocolVersion: "2025-11-25",
  });
});

test("writeCredentialsFile accepts oauth conformance results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-creds-test-"));
  const filePath = path.join(directory, "conformance-credentials.json");

  await writeCredentialsFile(filePath, createOAuthConformanceResult(), NOW);

  const fileMode = (await stat(filePath)).mode & 0o777;
  assert.equal(fileMode, 0o600);
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(payload, {
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "conformance-access-token",
    refreshToken: "conformance-refresh-token",
    clientId: "conformance-client-id",
    clientSecret: "conformance-client-secret",
    tokenType: "Bearer",
    expiresAt: "2026-04-26T12:30:00.000Z",
    protocolVersion: "2025-11-25",
  });
});

test("writeCredentialsFile validates generated contents before writing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-creds-test-"));

  const missingClientId = createOAuthLoginResult();
  delete (missingClientId.credentials as { accessToken?: string }).accessToken;
  delete (missingClientId.credentials as { clientId?: string }).clientId;

  await assert.rejects(
    () =>
      writeCredentialsFile(
        path.join(directory, "missing-client-id.json"),
        missingClientId,
        NOW,
      ),
    (error) =>
      error instanceof CliError &&
      error.message.includes("with refreshToken requires clientId"),
  );

  const invalidServerUrl = createOAuthLoginResult();
  invalidServerUrl.serverUrl = "file:///tmp/mcp";

  await assert.rejects(
    () =>
      writeCredentialsFile(
        path.join(directory, "invalid-server-url.json"),
        invalidServerUrl,
        NOW,
      ),
    (error) =>
      error instanceof CliError &&
      error.message.includes("serverUrl must use http or https"),
  );
});

test("readCredentialsFile validates required shape", async () => {
  const validPath = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "access-token",
  });

  assert.deepEqual(readCredentialsFile(validPath), {
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "access-token",
  });

  for (const contents of [
    "{",
    JSON.stringify({ version: 2, serverUrl: "https://example.com/mcp", accessToken: "token" }),
    JSON.stringify({ version: 1, serverUrl: "https://example.com/mcp" }),
    JSON.stringify({ version: 1, serverUrl: "not-a-url", accessToken: "token" }),
    JSON.stringify({ version: 1, serverUrl: "file:///tmp/mcp", accessToken: "token" }),
    JSON.stringify({ version: 1, serverUrl: "https://example.com/mcp", accessToken: 123 }),
    JSON.stringify({
      version: 1,
      serverUrl: "https://example.com/mcp",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    }),
  ]) {
    const invalidPath = await writeCredentialsJsonRaw(contents);
    assert.throws(
      () => readCredentialsFile(invalidPath),
      (error) => error instanceof CliError && error.exitCode === 2,
    );
  }
});

test("resolveCredentialsFileAuth selects access-token or refresh-token auth", async () => {
  const accessPath = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    expiresAt: "2026-04-26T12:02:00.000Z",
  });

  assert.deepEqual(
    resolveCredentialsFileAuth(accessPath, "https://example.com/mcp", NOW),
    { accessToken: "access-token" },
  );

  const trailingSlashPath = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp/",
    accessToken: "slash-token",
  });

  assert.deepEqual(
    resolveCredentialsFileAuth(trailingSlashPath, "https://example.com/mcp", NOW),
    { accessToken: "slash-token" },
  );

  const expiredPath = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "expired-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    clientSecret: "client-secret",
    expiresAt: "2026-04-26T12:00:30.000Z",
  });

  assert.deepEqual(
    resolveCredentialsFileAuth(expiredPath, "https://example.com/mcp", NOW),
    {
      refreshToken: "refresh-token",
      clientId: "client-id",
      clientSecret: "client-secret",
    },
  );
});

test("resolveCredentialsFileAccessToken requires a matching non-expired token", async () => {
  const expiredPath = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "expired-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    expiresAt: "2026-04-26T12:00:30.000Z",
  });

  assert.throws(
    () => resolveCredentialsFileAccessToken(expiredPath, "https://example.com/mcp", NOW),
    (error) =>
      error instanceof CliError &&
      error.message.includes("non-expired access token"),
  );

  assert.throws(
    () => resolveCredentialsFileAuth(expiredPath, "https://other.example.com/mcp", NOW),
    (error) =>
      error instanceof CliError &&
      error.message.includes("was issued for"),
  );
});

test("redactCredentialsFromResult replaces saved secrets and redacts nested values", () => {
  const result = createOAuthLoginResult();
  const redacted = redactCredentialsFromResult(result, "/tmp/credentials.json") as {
    credentials: Record<string, unknown>;
    credentialsFile: string;
    state: { nested: { accessToken: string } };
  };

  assert.equal(redacted.credentials.accessToken, "[SAVED_TO_FILE]");
  assert.equal(redacted.credentials.refreshToken, "[SAVED_TO_FILE]");
  assert.equal(redacted.credentials.clientSecret, "[SAVED_TO_FILE]");
  assert.equal(redacted.credentials.clientId, "client-id");
  assert.equal(redacted.credentialsFile, "/tmp/credentials.json");
  assert.equal(redacted.state.nested.accessToken, "[REDACTED]");
});

test("redactCredentialsFromResult does not claim unsaved secrets were written", () => {
  const result = createOAuthLoginResult();
  const redacted = redactCredentialsFromResult(result) as {
    credentials: Record<string, unknown>;
    credentialsFile?: string;
  };

  assert.equal(redacted.credentials.accessToken, "[REDACTED]");
  assert.equal(redacted.credentials.refreshToken, "[REDACTED]");
  assert.equal(redacted.credentials.clientSecret, "[REDACTED]");
  assert.equal(redacted.credentials.clientId, "client-id");
  assert.equal(redacted.credentialsFile, undefined);
});

async function writeCredentialsJsonRaw(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-creds-test-"));
  const filePath = path.join(directory, "credentials.json");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}
