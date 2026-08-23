import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PLATFORM_API_BASE_URL } from "@mcpjam/sdk/platform";
import { CliError } from "../src/lib/output.js";
import {
  MISSING_CLOUD_CREDENTIAL_MESSAGE,
  formatCloudAudienceLine,
  preflightCloudCredentials,
} from "../src/lib/cloud-context.js";

function authFile(body: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mcpjam-audience-"));
  const filePath = path.join(directory, "auth.json");
  writeFileSync(filePath, JSON.stringify({ version: 1, ...body }));
  return filePath;
}

test("formatCloudAudienceLine redacts API keys and names project scope", () => {
  const line = formatCloudAudienceLine({
    scope: { kind: "project", source: "automatic" },
    options: { apiKey: "sk_live_abcd1234", apiUrl: "https://example.test/api/v1" },
    env: {},
    authFilePath: path.join(tmpdir(), "no-auth.json"),
  });
  assert.equal(
    line,
    "Using MCPJam Cloud as sk_…1234 · project: automatic (most recently updated) · https://example.test/api/v1"
  );
});

test("formatCloudAudienceLine prefers stored OAuth email over the oauth fallback", () => {
  const authFilePath = authFile({
    issuer: "https://login.example.com",
    clientId: "c",
    tokenEndpoint: "https://login.example.com/token",
    accessToken: "tok",
    email: "dev@example.com",
    apiUrl: "https://staging.example.com/api/v1",
  });
  const withEmail = formatCloudAudienceLine({
    scope: { kind: "account" },
    options: {},
    env: {},
    authFilePath,
  });
  assert.equal(
    withEmail,
    "Using MCPJam Cloud as dev@example.com · account · https://staging.example.com/api/v1"
  );

  const noEmailPath = authFile({
    issuer: "https://login.example.com",
    clientId: "c",
    tokenEndpoint: "https://login.example.com/token",
    accessToken: "tok",
  });
  const withoutEmail = formatCloudAudienceLine({
    scope: { kind: "all-projects" },
    options: {},
    env: {},
    authFilePath: noEmailPath,
  });
  assert.equal(
    withoutEmail,
    `Using MCPJam Cloud as oauth · all projects · ${DEFAULT_PLATFORM_API_BASE_URL}`
  );
});

test("preflightCloudCredentials uses the shared login guidance", () => {
  assert.throws(
    () =>
      preflightCloudCredentials(
        {},
        { env: {}, authFilePath: path.join(tmpdir(), "no-auth.json") }
      ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, MISSING_CLOUD_CREDENTIAL_MESSAGE);
      return true;
    }
  );
});

test("preflightCloudCredentials rejects a legacy --api-key as a usage error", () => {
  assert.throws(
    () =>
      preflightCloudCredentials(
        { apiKey: "mcpjam_legacy" },
        { env: {}, authFilePath: path.join(tmpdir(), "no-auth.json") }
      ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "USAGE_ERROR");
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /Legacy mcpjam_ API keys/);
      return true;
    }
  );
});

test("preflightCloudCredentials rejects an invalid --api-url as a usage error", () => {
  assert.throws(
    () =>
      preflightCloudCredentials(
        { apiKey: "sk_test", apiUrl: "not-a-url" },
        { env: {}, authFilePath: path.join(tmpdir(), "no-auth.json") }
      ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "USAGE_ERROR");
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /Invalid --api-url/);
      return true;
    }
  );
});

test("preflightCloudCredentials names a leftover legacy MCPJAM_API_KEY", () => {
  assert.throws(
    () =>
      preflightCloudCredentials(
        {},
        {
          env: { MCPJAM_API_KEY: "mcpjam_legacy" },
          authFilePath: path.join(tmpdir(), "no-auth.json"),
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 1);
      assert.ok(error.message.includes(MISSING_CLOUD_CREDENTIAL_MESSAGE));
      assert.match(error.message, /Ignoring legacy mcpjam_ key in MCPJAM_API_KEY/);
      assert.match(error.message, /Legacy mcpjam_ API keys/);
      return true;
    }
  );
});
