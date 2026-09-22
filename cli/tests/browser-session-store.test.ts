import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  forgetSession,
  forgetSessionIf,
  getBrowserStateFilePath,
  readBrowserState,
  rememberSession,
  writeBrowserState,
} from "../src/lib/browser-session-store.js";

test("getBrowserStateFilePath respects XDG_CONFIG_HOME on posix", () => {
  assert.equal(
    getBrowserStateFilePath({
      env: { XDG_CONFIG_HOME: "/custom/config" },
      platform: "linux",
      homeDirectory: "/home/user",
    }),
    path.join("/custom/config", "mcpjam", "browser.json"),
  );
});

test("getBrowserStateFilePath uses APPDATA on windows", () => {
  assert.equal(
    getBrowserStateFilePath({
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      platform: "win32",
      homeDirectory: "C:\\Users\\u",
    }),
    path.join("C:\\Users\\u\\AppData\\Roaming", "mcpjam", "browser.json"),
  );
});

test("an explicit override wins, for CI and tests", () => {
  assert.equal(
    getBrowserStateFilePath({
      env: { MCPJAM_BROWSER_STATE_FILE: "/tmp/state.json" },
      platform: "linux",
      homeDirectory: "/home/user",
    }),
    "/tmp/state.json",
  );
});

test("a missing file reads as empty rather than throwing", () => {
  // No file yet is the ordinary first-run state.
  assert.deepEqual(readBrowserState("/nonexistent/browser.json"), {
    version: 1,
  });
});

test("a corrupt file reads as empty, because the recovery is to grant again", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, "{ not json");
  assert.deepEqual(readBrowserState(file), { version: 1 });
});

test("the consent capability round-trips, and the file is private", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "nested", "browser.json");
  await writeBrowserState(file, { version: 1, browserConsent: "cap-abc" });
  assert.equal(readBrowserState(file).browserConsent, "cap-abc");
  // The consent capability is a credential; the session ids name somebody's
  // browsing history.
  assert.equal((await stat(file)).mode & 0o077, 0);
  assert.match(await readFile(file, "utf8"), /cap-abc/);
});

test("re-writing an existing loose file tightens its mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  const { writeFile, chmod } = await import("node:fs/promises");
  await writeFile(file, "{}");
  await chmod(file, 0o644);
  // The atomic write creates a fresh 0600 temp file and renames it over the
  // loose one, so the destination is never briefly world-readable and there is
  // no follow-up chmod whose failure could be swallowed.
  await writeBrowserState(file, { version: 1, browserConsent: "cap" });
  assert.equal((await stat(file)).mode & 0o077, 0);
});

test("a write is atomic — an interrupted one cannot leave invalid JSON", async () => {
  // Losing this file loses the consent capability and every remembered
  // session, so a half-written destination is not an acceptable failure mode.
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  await writeBrowserState(file, { version: 1, browserConsent: "first" });
  await writeBrowserState(file, { version: 1, browserConsent: "second" });
  const { readdir } = await import("node:fs/promises");
  // No temp files left behind, and the destination still parses.
  assert.deepEqual(await readdir(dir), ["browser.json"]);
  assert.equal(readBrowserState(file).browserConsent, "second");
});

test("remembering a session does not disturb the consent or other projects", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  await writeBrowserState(file, { version: 1, browserConsent: "cap-abc" });
  await rememberSession(file, "proj-a", "bs_1");
  await rememberSession(file, "proj-b", "bs_2");
  const state = readBrowserState(file);
  assert.equal(state.browserConsent, "cap-abc");
  assert.deepEqual(state.sessions, { "proj-a": "bs_1", "proj-b": "bs_2" });

  await forgetSession(file, "proj-a");
  const after = readBrowserState(file);
  assert.deepEqual(after.sessions, { "proj-b": "bs_2" });
  // Closing one session must not sign the machine out of the browser.
  assert.equal(after.browserConsent, "cap-abc");
});

test("forgetting only applies to the session actually named", async () => {
  // `close --session <other>` used to drop this project's remembered default
  // whatever it closed, so the next command reported no open session while
  // that session was still running. Closing one is not a claim about another.
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  await rememberSession(file, "proj-a", "bs_live");

  assert.equal(await forgetSessionIf(file, "proj-a", "bs_other"), false);
  assert.equal(readBrowserState(file).sessions?.["proj-a"], "bs_live");

  assert.equal(await forgetSessionIf(file, "proj-a", "bs_live"), true);
  assert.equal(readBrowserState(file).sessions?.["proj-a"], undefined);
});

test("forgetting a session that was never remembered is a no-op", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  await writeBrowserState(file, { version: 1, browserConsent: "cap" });
  await forgetSession(file, "nope");
  assert.equal(readBrowserState(file).browserConsent, "cap");
});

test("a sessions map with non-string values is dropped rather than trusted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-browser-store-"));
  const file = path.join(dir, "browser.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    file,
    JSON.stringify({ version: 1, browserConsent: "cap", sessions: { a: 7 } })
  );
  const state = readBrowserState(file);
  assert.equal(state.browserConsent, "cap");
  assert.equal(state.sessions, undefined);
});
