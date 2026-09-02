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

  it("exits non-zero, and says why, when the server build is absent", () => {
    // The suite runs from source, where `dist/server/harness-install-cli.js`
    // has not been built — which is also the state a user meets after cloning,
    // so the message has to send them somewhere useful.
    const { code, output } = run(["harness", "status"]);
    expect(code).toBe(1);
    expect(output).toMatch(
      /server build is missing|does not expose|could not load/,
    );
  });
});
