import { beforeEach, describe, expect, it, vi } from "vitest";
const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: command,
}));
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: (fn: Parameters<typeof actual.promisify>[0]) =>
      fn === command ? command : actual.promisify(fn),
  };
});
import { readUnattendedGitStatus } from "../run-resources";

describe("unattended Git readiness", () => {
  beforeEach(() => command.mockReset());
  it.each(["2.31.0", "2.48.1", "3.0.0"])("accepts Git %s", async (version) => {
    command.mockResolvedValue({ stdout: `git version ${version}` });
    expect(await readUnattendedGitStatus("codex")).toMatchObject({
      ready: true,
    });
  });
  it.each(["git version 2.30.9", "not git"])("refuses %s", async (stdout) => {
    command.mockResolvedValue({ stdout });
    expect(await readUnattendedGitStatus("codex")).toMatchObject({
      ready: false,
      message: expect.stringContaining("2.31"),
    });
  });
  it("reports a missing executable as a recoverable prerequisite", async () => {
    command.mockImplementationOnce(() => { throw new Error("ENOENT"); });
    expect(await readUnattendedGitStatus("codex")).toMatchObject({
      ready: false,
      message: expect.stringContaining("Install Git"),
    });
  });
});
