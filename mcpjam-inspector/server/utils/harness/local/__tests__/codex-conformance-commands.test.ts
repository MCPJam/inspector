import { expect, it } from "vitest";
import { codexConformanceCommands } from "../conformance/codex-commands.js";

it("quotes Windows paths with spaces and apostrophes for PowerShell", () => {
  const commands = codexConformanceCommands({
    platform: "win32",
    outsidePath: "C:\\Users\\O'Brien\\outside file",
    gatewayPort: 4321,
    upstreamKeyCanary: "test-canary",
  });
  expect(commands.outside).toContain(
    "-LiteralPath 'C:\\Users\\O''Brien\\outside file'",
  );
  expect(commands.tmpdir).toContain("$env:TMPDIR");
  expect(commands.network).toContain("ConnectAsync('127.0.0.1', 4321)");
  expect(commands.environment).toContain("test-canary");
  expect(commands.marker).toContain('"run`n"');
});

it("keeps POSIX conformance commands and quotes paths", () => {
  const commands = codexConformanceCommands({
    platform: "linux",
    outsidePath: "/tmp/outside file",
    gatewayPort: 4321,
    upstreamKeyCanary: "test-canary",
  });
  expect(commands.read).toBe("cat hello.txt");
  expect(commands.outside).toContain('> "/tmp/outside file"');
  expect(commands.network).toContain("/dev/tcp/127.0.0.1/4321");
});
