import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";

// Point the workspace root at a scratch dir — never the developer's real
// ~/.mcpjam. homedir() is the only path input local-machine consumes.
const scratch = mkdtempSync(join(tmpdir(), "mcpjam-local-machine-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

import {
  LOCAL_COMMAND_ENV_ALLOWLIST,
  buildLocalCommandEnv,
  getLocalComputerWorkspaceDir,
  getLocalComputerWorkspaceRoot,
  isLocalComputerEngineAvailable,
  localBashRunner,
  resetLocalBashPathCacheForTests,
  resolveLocalBashPath,
  runLocalComputerCommand,
  validateLocalProjectKey,
} from "../local-machine.js";
import { MSYS_COMMAND_ID_ENV } from "../msys-process-tree.js";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  resetLocalBashPathCacheForTests();
});

describe("isLocalComputerEngineAvailable", () => {
  it("is available in a plain non-hosted test env (bash on PATH)", () => {
    expect(isLocalComputerEngineAvailable()).toEqual({ available: true });
  });
});

describe("buildLocalCommandEnv", () => {
  it("is an allowlist — inspector-held secrets never pass through", () => {
    const env = buildLocalCommandEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      E2B_API_KEY: "sk-secret",
      INSPECTOR_SERVICE_TOKEN: "svc",
      COMPUTERS_TERMINAL_TOKEN_SECRET: "t",
      CONVEX_HTTP_URL: "https://x",
      OPENROUTER_API_KEY: "or",
      ANTHROPIC_API_KEY: "an",
      RANDOM_APP_CONFIG: "x",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    for (const name of Object.keys(env)) {
      expect(LOCAL_COMMAND_ENV_ALLOWLIST).toContain(name);
    }
    expect(env.E2B_API_KEY).toBeUndefined();
    expect(env.INSPECTOR_SERVICE_TOKEN).toBeUndefined();
    expect(env.CONVEX_HTTP_URL).toBeUndefined();
    expect(env.RANDOM_APP_CONFIG).toBeUndefined();
  });

  it("the allowlist itself stays deliberate — additions are reviewed acts", () => {
    // Sorted snapshot so a drive-by addition shows up in review as a diff of
    // THIS test, not just of the module.
    expect([...LOCAL_COMMAND_ENV_ALLOWLIST].sort()).toEqual(
      [
        "COMSPEC",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOGNAME",
        "PATH",
        "PATHEXT",
        "SHELL",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "TZ",
        "USER",
        "USERPROFILE",
        "WINDIR",
      ].sort()
    );
  });
});

describe("validateLocalProjectKey / workspace dir", () => {
  it.each([
    "../../escape",
    "a/b",
    "a\\b",
    "",
    ".",
    "..",
    "a b",
    "x".repeat(129),
    "nul\0byte",
  ])("rejects %j", (bad) => {
    expect(() => validateLocalProjectKey(bad)).toThrow();
  });

  it("accepts a Convex-shaped id and creates the dir under the root", async () => {
    const dir = await getLocalComputerWorkspaceDir("proj_abc-123");
    expect(dir.startsWith(getLocalComputerWorkspaceRoot() + sep)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("localBashRunner", () => {
  it("captures stdout/stderr and the exit code", async () => {
    const result = await localBashRunner({
      sandboxId: "local-machine",
      command: "echo out; echo err >&2; exit 3",
      timeoutMs: 10_000,
    });
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(3);
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const result = await localBashRunner({
      sandboxId: "local-machine",
      command: "sleep 30",
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  });

  it("kills on abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await localBashRunner({
      sandboxId: "local-machine",
      command: "sleep 30",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.exitCode).not.toBe(0);
  });

  // Asks the MSYS bash whether a pid from `$!` is still running.
  const msysPidAlive = (pid: string) =>
    spawnSync(resolveLocalBashPath()!, ["-c", `kill -0 ${pid}`]).status === 0;

  it.runIf(process.platform === "win32")(
    "returns and ends a descendant that outlives the shell and holds its output",
    async () => {
      const started = Date.now();
      const result = await localBashRunner({
        sandboxId: "local-machine",
        command: "sleep 60 & echo $!",
        timeoutMs: 500,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.exitCode).toBe(124);
      const pid = result.stdout.trim();
      expect(pid).toMatch(/^\d+$/);
      expect(msysPidAlive(pid)).toBe(false);
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "returns at the deadline when a descendant escapes termination",
    async () => {
      // Scrubbing the command id hides this sleep from the reaper, the case
      // where termination cannot reach a pipe holder.
      const started = Date.now();
      const result = await localBashRunner({
        sandboxId: "local-machine",
        command: `env -u ${MSYS_COMMAND_ID_ENV} sleep 60 & echo $!`,
        timeoutMs: 500,
      });
      const pid = result.stdout.trim();
      try {
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(result.exitCode).toBe(124);
        expect(msysPidAlive(pid)).toBe(true);
      } finally {
        spawnSync(resolveLocalBashPath()!, ["-c", `kill -9 ${pid}`]);
      }
    },
    20_000,
  );

  it("spawns with the sanitized env", async () => {
    process.env.MCPJAM_LOCAL_MACHINE_TEST_SECRET = "leak-me";
    try {
      const result = await localBashRunner({
        sandboxId: "local-machine",
        command: "echo [${MCPJAM_LOCAL_MACHINE_TEST_SECRET:-absent}]",
        timeoutMs: 10_000,
      });
      expect(result.stdout.trim()).toBe("[absent]");
    } finally {
      delete process.env.MCPJAM_LOCAL_MACHINE_TEST_SECRET;
    }
  });
});

async function waitForJournalEntry(commandId: string): Promise<void> {
  await vi.waitFor(() => {
    const log = readFileSync(
      join(getLocalComputerWorkspaceRoot(), "logs", "commands.jsonl"),
      "utf8"
    );
    expect(log).toContain(JSON.stringify({ commandId }).slice(1, -1));
  });
}

describe("runLocalComputerCommand", () => {
  it("runs in the project workspace dir and journals the command", async () => {
    const result = await runLocalComputerCommand({
      projectId: "proj1",
      // Git Bash prints /d/... unless asked for the Windows form.
      command: process.platform === "win32" ? "pwd -W" : "pwd",
      commandId: "cmd-1",
    });
    if ("error" in result) throw new Error(result.error);
    // Physical-path compare: the scratch tmpdir may sit behind a symlink
    // (macOS /var → /private/var), and the sanitized env has no $PWD, so
    // bash prints the resolved path.
    expect(normalize(result.stdout.trim())).toBe(
      realpathSync(await getLocalComputerWorkspaceDir("proj1"))
    );
    await waitForJournalEntry("cmd-1");
  });

  it("returns an error (not a throw) for an invalid project key", async () => {
    const result = await runLocalComputerCommand({
      projectId: "../../escape",
      command: "echo hi",
      commandId: "cmd-2",
    });
    expect("error" in result).toBe(true);
    // And nothing was created outside the root.
    expect(existsSync(join(scratch, "escape"))).toBe(false);
  });

  it("applies the model output cap", async () => {
    const result = await runLocalComputerCommand({
      projectId: "proj1",
      command: "yes x 2>/dev/null | head -c 100000; true",
      commandId: "cmd-3",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.stdout.length).toBeLessThan(20_000);
    expect(result.stdout).toContain("truncated");
    // The command returns before its journal write. Do not remove the scratch
    // directory in afterAll while that write is still creating files.
    await waitForJournalEntry("cmd-3");
  });
});
