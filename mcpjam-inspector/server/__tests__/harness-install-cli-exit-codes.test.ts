/**
 * `mcpjam-inspector harness <install|status>`, exercised through the CLI.
 *
 * Lives under `server/` because that is where the vitest workspace looks, and
 * because the bundle the command loads (`dist/server/harness-install-cli.js`)
 * is built from here.
 *
 * Spawned rather than imported: `bin/start.js` is a program, not a module —
 * importing it runs `main()` and, on most argument shapes, starts a server.
 * What these tests care about is what a script consuming this command actually
 * sees, which is the exit code, and that is only real at the process boundary.
 *
 * They exist because the code they cover was silently wrong: every path
 * returned its answer to an entry point that threw it away and exited 0, so
 * `harness status` reported success on a machine with no runtime pack.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "start.js",
);

function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.status ?? -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("the harness subcommand reports its answer in the exit code", () => {
  it("exits 2 on a usage error", () => {
    const { code, output } = run(["harness", "bogus"]);
    expect(code).toBe(2);
    expect(output).toContain("usage: mcpjam-inspector harness");
  });

  it("exits 2 when no action is given at all", () => {
    expect(run(["harness"]).code).toBe(2);
  });

  it("reports 'not installed' as a non-zero exit, however it got there", () => {
    // Branches on whether `dist/` exists, because BOTH states are real and
    // this suite runs in both: from source before a build (where the CLI
    // reports the missing bundle) and after `build:server` in CI (where it
    // loads the real installer, finds no pack, and prints a status). The one
    // thing that has to hold in either is the exit code — which is what was
    // broken, and what a script consuming this command reads.
    const built = existsSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "dist",
        "server",
        "harness-install-cli.js",
      ),
    );
    const { code, output } = run(["harness", "status"]);
    expect(code).toBe(1);
    if (built) {
      // The installer answered: a state, as JSON, and never `ready` here —
      // no pack is installed in a test environment. Stripped of ANSI first:
      // `bin/start.js` prints through `log`, which wraps every message in
      // `colors.reset`, so the payload arrives wrapped in escape sequences
      // that `trim()` does not touch. `JSON.parse` threw a SyntaxError
      // instead of asserting anything — in the branch that only runs in CI
      // after a build, which is why it never showed up locally.
      const json = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
      expect(JSON.parse(json).state).not.toBe("ready");
    } else {
      expect(output).toMatch(
        /server build is missing|does not expose|could not load/,
      );
    }
  });
});
