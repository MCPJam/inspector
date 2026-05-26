import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildConfig } from "../src/commands/conformance.js";
import { CliError } from "../src/lib/output.js";

async function writeCredentialsJson(contents: object): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-conformance-"));
  const filePath = path.join(directory, "credentials.json");
  await writeFile(filePath, `${JSON.stringify(contents)}\n`, "utf8");
  return filePath;
}

test("buildConfig rejects non-http URLs", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "file:///tmp/mcp.sock",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Invalid URL scheme"),
  );
});

test("buildConfig rejects unknown categories and check ids", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        category: ["core", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown category"),
  );

  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        checkId: ["ping", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown check id"),
  );
});

test("buildConfig preserves validated conformance filters", () => {
  const config = buildConfig({
    url: "https://example.com/mcp",
    category: ["core"],
    checkId: ["ping"],
  });

  assert.deepEqual(config.categories, ["core"]);
  assert.deepEqual(config.checkIds, ["ping"]);
});

test("buildConfig loads access-token auth from a credentials file", async () => {
  const credentialsFile = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "file-access-token",
    expiresAt: "2999-01-01T00:00:00.000Z",
  });

  const config = buildConfig({
    url: "https://example.com/mcp",
    credentialsFile,
  });

  assert.equal(config.accessToken, "file-access-token");
});

test("buildConfig rejects credentials-file auth conflicts", async () => {
  const credentialsFile = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "file-access-token",
  });

  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        credentialsFile,
        accessToken: "explicit-token",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--credentials-file cannot be used together"),
  );
});
