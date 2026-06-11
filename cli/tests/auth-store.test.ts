import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearStoredAuth,
  getAuthFilePath,
  readStoredAuth,
  writeStoredAuth,
  type StoredPlatformAuth,
} from "../src/lib/auth-store.js";

function storedAuth(
  overrides: Partial<StoredPlatformAuth> = {},
): StoredPlatformAuth {
  return {
    version: 1,
    issuer: "https://login.example.com",
    clientId: "client_123",
    tokenEndpoint: "https://login.example.com/oauth2/token",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 1893456000000,
    ...overrides,
  };
}

test("getAuthFilePath respects XDG_CONFIG_HOME on posix", () => {
  assert.equal(
    getAuthFilePath({
      env: { XDG_CONFIG_HOME: "/custom/config" },
      platform: "linux",
      homeDirectory: "/home/user",
    }),
    path.join("/custom/config", "mcpjam", "auth.json"),
  );
});

test("getAuthFilePath defaults to ~/.config on posix", () => {
  assert.equal(
    getAuthFilePath({ env: {}, platform: "darwin", homeDirectory: "/Users/u" }),
    path.join("/Users/u", ".config", "mcpjam", "auth.json"),
  );
});

test("getAuthFilePath uses APPDATA on windows", () => {
  assert.equal(
    getAuthFilePath({
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      platform: "win32",
      homeDirectory: "C:\\Users\\u",
    }),
    path.join("C:\\Users\\u\\AppData\\Roaming", "mcpjam", "auth.json"),
  );
});

test("writeStoredAuth round-trips with 0600 permissions and clearStoredAuth removes it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not meaningful on Windows");
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  const filePath = path.join(directory, "nested", "auth.json");
  const contents = storedAuth();

  await writeStoredAuth(contents, filePath);

  const fileStat = await stat(filePath);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.deepEqual(readStoredAuth(filePath), contents);

  assert.equal(await clearStoredAuth(filePath), true);
  assert.equal(readStoredAuth(filePath), null);
  assert.equal(await clearStoredAuth(filePath), false);
});

test("readStoredAuth returns null for missing, malformed, or wrong-shape files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  const filePath = path.join(directory, "auth.json");

  assert.equal(readStoredAuth(filePath), null);

  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, "not json", "utf8");
  assert.equal(readStoredAuth(filePath), null);

  await writeFile(filePath, JSON.stringify({ version: 2 }), "utf8");
  assert.equal(readStoredAuth(filePath), null);

  await writeFile(
    filePath,
    JSON.stringify({ ...storedAuth(), accessToken: 42 }),
    "utf8",
  );
  assert.equal(readStoredAuth(filePath), null);
});

test("readStoredAuth tolerates absent optional fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-auth-"));
  const filePath = path.join(directory, "auth.json");
  const minimal = storedAuth();
  delete minimal.refreshToken;
  delete minimal.expiresAt;

  await writeStoredAuth(minimal, filePath);

  assert.deepEqual(readStoredAuth(filePath), minimal);
});
