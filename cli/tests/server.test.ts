import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveServerProbeAccessToken } from "../src/commands/server.js";
import { CliError } from "../src/lib/output.js";

async function writeCredentialsJson(contents: object): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-server-"));
  const filePath = path.join(directory, "credentials.json");
  await writeFile(filePath, `${JSON.stringify(contents)}\n`, "utf8");
  return filePath;
}

test("resolveServerProbeAccessToken loads a bearer token from credentials file", async () => {
  const credentialsFile = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "file-access-token",
    expiresAt: "2999-01-01T00:00:00.000Z",
  });

  assert.equal(
    resolveServerProbeAccessToken({
      url: "https://example.com/mcp",
      credentialsFile,
    }),
    "file-access-token",
  );
});

test("resolveServerProbeAccessToken rejects expired and conflicting credential sources", async () => {
  const credentialsFile = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "expired-token",
    refreshToken: "refresh-token",
    clientId: "client-id",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });

  assert.throws(
    () =>
      resolveServerProbeAccessToken({
        url: "https://example.com/mcp",
        credentialsFile,
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("non-expired access token"),
  );

  assert.throws(
    () =>
      resolveServerProbeAccessToken({
        url: "https://example.com/mcp",
        credentialsFile,
        accessToken: "explicit-token",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--credentials-file cannot be used together"),
  );
});
