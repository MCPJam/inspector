import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PLATFORM_API_BASE_URL } from "@mcpjam/sdk/platform";
import { describeCloudCredential, redactCloudApiKey } from "../src/lib/credential-describe.js";
import { LEGACY_KEY_REMEDY } from "../src/lib/platform-auth.js";

function authFile(body: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mcpjam-cred-"));
  const filePath = path.join(directory, "auth.json");
  writeFileSync(filePath, JSON.stringify({ version: 1, ...body }));
  return filePath;
}

test("redactCloudApiKey keeps sk_ prefix and last four characters", () => {
  assert.equal(redactCloudApiKey("sk_live_abcd1234"), "sk_…1234");
});

test("redactCloudApiKey hides short secrets and does not assume sk_", () => {
  assert.equal(redactCloudApiKey("sk_ab"), "sk_…");
  assert.equal(redactCloudApiKey("pk_abcd1234efgh"), "pk_…efgh");
  assert.equal(redactCloudApiKey("short"), "…");
});

test("credential precedence is flag, usable env key, oauth, missing", () => {
  const authFilePath = authFile({
    issuer: "https://login.example.com",
    clientId: "c",
    tokenEndpoint: "https://login.example.com/token",
    accessToken: "tok",
    apiUrl: "https://staging.example.com/api/v1",
  });

  const flag = describeCloudCredential(
    { apiKey: "sk_flag_xxxxYYYY" },
    { env: { MCPJAM_API_KEY: "sk_env_zzzz" }, authFilePath }
  );
  assert.equal(flag.credential.source, "flag");
  assert.equal(flag.credential.valid, true);
  assert.equal(flag.credential.redactedKey, "sk_…YYYY");
  assert.equal(flag.credential.envShadowsOauth, false);
  assert.equal(flag.deployment.valid, true);

  const env = describeCloudCredential(
    {},
    { env: { MCPJAM_API_KEY: "sk_env_zzzzQQQQ" }, authFilePath }
  );
  assert.equal(env.credential.source, "env");
  assert.equal(env.credential.envShadowsOauth, true);
  assert.equal(env.credential.redactedKey, "sk_…QQQQ");

  const oauth = describeCloudCredential({}, { env: {}, authFilePath });
  assert.equal(oauth.credential.source, "oauth");
  assert.equal(oauth.credential.kind, "oauth");
  assert.equal(oauth.deployment.source, "oauth");
  assert.equal(oauth.deployment.apiUrl, "https://staging.example.com/api/v1");

  const missing = describeCloudCredential(
    {},
    { env: {}, authFilePath: path.join(tmpdir(), "no-such-auth.json") }
  );
  assert.equal(missing.credential.source, "missing");
  assert.equal(missing.credential.valid, null);
  assert.equal(missing.deployment.source, "default");
  assert.equal(missing.deployment.valid, true);
  assert.equal(missing.deployment.apiUrl, DEFAULT_PLATFORM_API_BASE_URL);
});

test("legacy mcpjam_ flag keys are reported without throwing", () => {
  const described = describeCloudCredential(
    { apiKey: "mcpjam_legacy_secret" },
    { env: {} }
  );
  assert.equal(described.credential.valid, false);
  assert.equal(described.credential.error, LEGACY_KEY_REMEDY);
  assert.equal(described.credential.source, "flag");
  assert.equal(described.credential.redactedKey, "mcpjam_…cret");
  assert.doesNotMatch(
    JSON.stringify(described),
    /mcpjam_legacy_secret/
  );
});

test("invalid explicit API URLs are reported without throwing", () => {
  const described = describeCloudCredential(
    { apiKey: "sk_test_xxxxYYYY", apiUrl: "not-a-url" },
    { env: {} }
  );
  assert.equal(described.credential.valid, true);
  assert.equal(described.deployment.valid, false);
  assert.equal(described.deployment.apiUrl, "not-a-url");
  assert.match(described.deployment.error ?? "", /Invalid --api-url/);
  assert.equal(described.credential.redactedKey, "sk_…YYYY");
});

test("legacy mcpjam_ env keys fall through to stored OAuth", () => {
  const authFilePath = authFile({
    issuer: "https://login.example.com",
    clientId: "c",
    tokenEndpoint: "https://login.example.com/token",
    accessToken: "tok",
  });
  const described = describeCloudCredential(
    {},
    { env: { MCPJAM_API_KEY: "mcpjam_legacy" }, authFilePath }
  );
  assert.equal(described.credential.source, "oauth");
  assert.equal(described.credential.envShadowsOauth, false);
});

test("deployment precedence is flag, env, oauth, default", () => {
  const authFilePath = authFile({
    issuer: "https://login.example.com",
    clientId: "c",
    tokenEndpoint: "https://login.example.com/token",
    accessToken: "tok",
    apiUrl: "https://oauth.example.com/api/v1",
  });

  assert.equal(
    describeCloudCredential(
      { apiUrl: "https://flag.example.com/api/v1" },
      { env: { MCPJAM_API_URL: "https://env.example.com/api/v1" }, authFilePath }
    ).deployment.source,
    "flag"
  );
  assert.equal(
    describeCloudCredential(
      {},
      { env: { MCPJAM_API_URL: "https://env.example.com/api/v1" }, authFilePath }
    ).deployment.source,
    "env"
  );
});
