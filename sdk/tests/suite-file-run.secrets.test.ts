/**
 * Which config values the local runner treats as secrets: explicit
 * credentials always; a header, environment or URL value only when its name
 * or its shape says it is one. Configuration such as `NODE_ENV=production`
 * is not a secret, and scrubbing it would redact the word from every error.
 */
import { describe, expect, it } from "vitest";
import {
  addServerConfigSecrets,
  createSecretScrubber,
  isSensitiveName,
  looksLikeCredential,
} from "../src/suite-file-run/secrets.js";

describe("isSensitiveName", () => {
  it("recognizes credential names in every common spelling", () => {
    for (const name of [
      "Authorization",
      "Proxy-Authorization",
      "x-api-key",
      "X-Auth-Token",
      "Cookie",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GH_PAT",
      "MYSQL_PWD",
      "DB_PASSWORD",
      "apiToken",
      "APITOKEN",
      "sig",
      "access_token",
    ]) {
      expect(isSensitiveName(name), name).toBe(true);
    }
  });

  it("does not mistake configuration for a credential", () => {
    for (const name of [
      "PATH",
      "NODE_ENV",
      "GIT_AUTHOR_NAME",
      "CLIENT",
      "x-client",
      "region",
      "LOG_LEVEL",
      "HOME",
    ]) {
      expect(isSensitiveName(name), name).toBe(false);
    }
  });
});

describe("looksLikeCredential", () => {
  it("recognizes token shapes under any name", () => {
    for (const value of [
      "ghp_abcdefghijklmnop1234",
      "sk-ant-api03-SENTINEL",
      "xoxb-1234-abcd",
      "0123456789abcdef0123456789abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    ]) {
      expect(looksLikeCredential(value), value).toBe(true);
    }
  });

  it("does not mistake words, paths or URLs for one", () => {
    for (const value of [
      "production",
      "mcpjam",
      "/usr/local/bin:/usr/bin",
      "https://api.example.com/v1/items?page=2",
      "en_US.UTF-8",
      "two words 12345678901234567890",
    ]) {
      expect(looksLikeCredential(value), value).toBe(false);
    }
  });
});

describe("addServerConfigSecrets", () => {
  it("collects credentials and leaves configuration alone", () => {
    const scrubber = createSecretScrubber();
    addServerConfigSecrets(scrubber, {
      command: "node",
      env: {
        NODE_ENV: "production",
        CLIENT: "mcpjam",
        GITHUB_TOKEN: "tok_value_1",
        DATABASE_URL: "postgres://app:dbpass123@db.internal/app",
        HOOK_URL: "https://hooks.example.com/cb?sig=abc123def&page=2",
        SERVICE_ID: "0123456789abcdef0123456789abcdef",
      },
      requestInit: {
        headers: {
          "x-client": "mcpjam",
          Authorization: "Bearer bearer_token_value",
          "x-trace": "Bearer innocuous_name_bearer",
        },
      },
      accessToken: "explicit_access_token",
    });
    expect(
      scrubber.scrub(
        "production mcpjam page=2 | tok_value_1 dbpass123 abc123def " +
          "0123456789abcdef0123456789abcdef bearer_token_value " +
          "innocuous_name_bearer explicit_access_token"
      )
    ).toBe(
      "production mcpjam page=2 | [REDACTED] [REDACTED] [REDACTED] " +
        "[REDACTED] [REDACTED] [REDACTED] [REDACTED]"
    );
  });

  it("scrubs the longest secret whole when one contains another", () => {
    const scrubber = createSecretScrubber();
    scrubber.add("secret_value");
    expect(scrubber.scrub("x secret_value y")).toBe("x [REDACTED] y");
    // Added after a scrub: the cached order is rebuilt.
    scrubber.add("secret_value_longer");
    expect(scrubber.scrub("secret_value_longer")).toBe("[REDACTED]");
  });
});
