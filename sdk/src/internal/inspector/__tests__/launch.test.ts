import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { npxInvocation, type NpxInvocation } from "../launch.js";

const noNpxCli = () => undefined;

// DEP0190 is emitted by the process that calls spawn, so spawn from a child
// Node and read its stderr.
function spawnFromChildNode(invocation: NpxInvocation) {
  const script = `
    const { spawnSync } = require("node:child_process");
    const { command, args, shell } = JSON.parse(process.argv[1]);
    const result = spawnSync(command, args, { shell, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  `;
  return spawnSync(
    process.execPath,
    ["-e", script, JSON.stringify(invocation)],
    { encoding: "utf8" },
  );
}

describe("npxInvocation", () => {
  it("spawns npx directly outside Windows", () => {
    expect(npxInvocation(["-y", "pkg@latest"], "linux")).toEqual({
      command: "npx",
      args: ["-y", "pkg@latest"],
      shell: false,
    });
  });

  it("runs npm's npx-cli.js with the current Node on Windows", () => {
    const npxCli = "C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
    expect(npxInvocation(["-y", "a b&c"], "win32", () => npxCli)).toEqual({
      command: process.execPath,
      args: [npxCli, "-y", "a b&c"],
      shell: false,
    });
  });

  it("falls back to one quoted cmd.exe command string without npx-cli.js", () => {
    expect(
      npxInvocation(
        ["-y", "@mcpjam/inspector@latest", "a b&c"],
        "win32",
        noNpxCli,
      ),
    ).toEqual({
      command: 'npx.cmd -y @mcpjam/inspector@latest "a b&c"',
      args: [],
      shell: true,
    });
  });

  it("doubles a trailing backslash before the closing quote", () => {
    expect(
      npxInvocation(
        ["--prefix", "C:\\my work\\", "--version"],
        "win32",
        noNpxCli,
      ).command,
    ).toBe('npx.cmd --prefix "C:\\my work\\\\" --version');
  });

  it.each(['say "hi"', "%PATH%", "x!y", "two\nlines"])(
    "refuses %j, which cmd.exe would still expand inside quotes",
    (arg) => {
      expect(() => npxInvocation([arg], "win32", noNpxCli)).toThrow(
        /cmd\.exe/,
      );
    },
  );

  it.runIf(process.platform === "win32").each([
    ["npx-cli.js", undefined],
    ["the cmd.exe fallback", noNpxCli],
  ] as const)(
    "spawns npx on this machine through %s without DEP0190",
    (_label, findNpxCli) => {
      const result = spawnFromChildNode(
        npxInvocation(["--version"], process.platform, findNpxCli),
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).not.toMatch(/DEP0190|DeprecationWarning/);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
  );
});
