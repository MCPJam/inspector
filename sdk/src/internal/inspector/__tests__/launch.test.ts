import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { npxInvocation } from "../launch.js";

describe("npxInvocation", () => {
  it("spawns npx directly outside Windows", () => {
    expect(npxInvocation(["-y", "pkg@latest"], "linux")).toEqual({
      command: "npx",
      args: ["-y", "pkg@latest"],
      shell: false,
    });
  });

  it("runs npx.cmd through a shell on Windows and quotes for cmd.exe", () => {
    expect(
      npxInvocation(["-y", "@mcpjam/inspector@latest", "a b&c"], "win32"),
    ).toEqual({
      command: "npx.cmd",
      args: ["-y", "@mcpjam/inspector@latest", '"a b&c"'],
      shell: true,
    });
  });

  it.each(['say "hi"', "%PATH%", "x!y", "two\nlines"])(
    "refuses %j, which cmd.exe would still expand inside quotes",
    (arg) => {
      expect(() => npxInvocation([arg], "win32")).toThrow(/cmd\.exe/);
    },
  );

  // Without `shell: true` this spawn fails with EINVAL (CVE-2024-27980).
  it.runIf(process.platform === "win32")("spawns npx on this machine", () => {
    const { command, args, shell } = npxInvocation(["--version"]);
    const result = spawnSync(command, args, { shell, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
