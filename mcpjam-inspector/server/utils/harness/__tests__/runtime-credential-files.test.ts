import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const loggerState = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logger.js", () => ({
  logger: { warn: loggerState.warn, info: vi.fn(), error: vi.fn() },
}));

import {
  cursorCredentialCleanupCommand,
  removeRuntimeCredentials,
} from "../runtime-credential-files";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  loggerState.warn.mockClear();
});

function touch(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}");
}

/** A box with the Cursor CLI's private home in every layout the bootstrap uses. */
function fakeBox() {
  const root = mkdtempSync(join(tmpdir(), "cursor-box-"));
  roots.push(root);
  const home = join(root, "home");
  // A workdir with a quote in it: host-configured, so it must stay one word.
  const workdir = join(root, "work dir's");
  const cliHomes = [
    join(workdir, ".harness-bootstrap/cursor/implementation/home"),
    join(home, ".ai-sdk-harness/.harness-bootstrap/cursor/implementation/home"),
    join(home, ".harness-bootstrap/cursor/implementation/home"),
    home,
  ];
  const auth = cliHomes.map((cliHome) =>
    join(cliHome, ".config/cursor/auth.json"),
  );
  // What `session/load` resumes from, and the CLI's saved settings.
  const sessionState = cliHomes.flatMap((cliHome) => [
    join(cliHome, ".cursor/chats/abc123/store.db"),
    join(cliHome, ".cursor/cli-config.json"),
  ]);
  for (const path of [...auth, ...sessionState]) touch(path);
  return { home, workdir, auth, sessionState };
}

const runInBox = (command: string, home: string, env: Record<string, string> = {}) =>
  execFileSync("bash", ["-c", command], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
  });

describe("cursorCredentialCleanupCommand", () => {
  it("removes every auth.json and leaves the ACP session state alone", () => {
    const box = fakeBox();
    runInBox(cursorCredentialCleanupCommand(box.workdir), box.home);
    for (const path of box.auth) expect(existsSync(path)).toBe(false);
    for (const path of box.sessionState) expect(existsSync(path)).toBe(true);
  });

  it("follows XDG_CONFIG_HOME when the box sets it", () => {
    const box = fakeBox();
    const xdg = join(box.home, "xdg");
    touch(join(xdg, "cursor/auth.json"));
    runInBox(cursorCredentialCleanupCommand(box.workdir), box.home, {
      XDG_CONFIG_HOME: xdg,
    });
    expect(existsSync(join(xdg, "cursor/auth.json"))).toBe(false);
  });

  it("succeeds when there is nothing to remove", () => {
    const box = fakeBox();
    for (const path of box.auth) rmSync(path);
    expect(() =>
      runInBox(cursorCredentialCleanupCommand(box.workdir), box.home),
    ).not.toThrow();
  });

  it("keeps a hostile workdir from running anything", () => {
    const box = fakeBox();
    const marker = join(box.home, "pwned");
    runInBox(
      cursorCredentialCleanupCommand(`${box.workdir}/$(touch ${marker})`),
      box.home,
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("removeRuntimeCredentials", () => {
  const signal = AbortSignal.timeout(1000);

  it("runs the adapter's command on the session", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await removeRuntimeCredentials({
      adapter: { id: "cursor", runtimeCredentialCleanupCommand: () => "rm -f -- x" },
      session: { run },
      sessionWorkDir: "/home/user",
      signal,
    });
    expect(run).toHaveBeenCalledWith({ command: "rm -f -- x", abortSignal: signal });
    expect(loggerState.warn).not.toHaveBeenCalled();
  });

  it("does nothing for a runtime that keeps no tokens", async () => {
    const run = vi.fn();
    await removeRuntimeCredentials({
      adapter: { id: "claude-code" },
      session: { run },
      sessionWorkDir: "/home/user",
      signal,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("logs a failure and never throws: the turn has already finished", async () => {
    const adapter = { id: "cursor", runtimeCredentialCleanupCommand: () => "rm" };
    await removeRuntimeCredentials({
      adapter,
      session: { run: async () => ({ exitCode: 1, stdout: "", stderr: "no" }) },
      sessionWorkDir: "/home/user",
      signal,
    });
    await removeRuntimeCredentials({
      adapter,
      session: {
        run: async () => {
          throw new Error("box gone");
        },
      },
      sessionWorkDir: "/home/user",
      signal,
    });
    expect(loggerState.warn).toHaveBeenCalledTimes(2);
  });
});
