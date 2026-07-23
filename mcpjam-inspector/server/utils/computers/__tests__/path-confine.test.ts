import { describe, it, expect } from "vitest";
import {
  confineToHome,
  resolveWorkingDirectory,
  HOME_ROOT,
} from "../path-confine.js";

describe("confineToHome", () => {
  it("accepts the home root itself", () => {
    expect(confineToHome("/home/user")).toBe("/home/user");
  });

  it("accepts a descendant of the home root", () => {
    expect(confineToHome("/home/user/.claude/skills/x")).toBe(
      "/home/user/.claude/skills/x"
    );
    expect(confineToHome("/home/user/claude-code-abc")).toBe(
      "/home/user/claude-code-abc"
    );
  });

  it("normalizes redundant separators and trailing slashes", () => {
    expect(confineToHome("/home/user//uploads/")).toBe("/home/user/uploads");
  });

  it("rejects paths that escape via ..", () => {
    expect(confineToHome("/home/user/../etc")).toBeNull();
    expect(confineToHome("/home/user/../../etc/passwd")).toBeNull();
    expect(confineToHome("/home/user/a/../../root")).toBeNull();
  });

  it("rejects absolute paths outside the home root", () => {
    expect(confineToHome("/etc/passwd")).toBeNull();
    expect(confineToHome("/tmp/x")).toBeNull();
    expect(confineToHome("/")).toBeNull();
  });

  it("rejects a sibling directory sharing the home prefix", () => {
    // `/home/user2` must not be treated as under `/home/user`.
    expect(confineToHome("/home/user2/secret")).toBeNull();
  });

  it("rejects missing, relative, and over-length inputs", () => {
    expect(confineToHome(undefined)).toBeNull();
    expect(confineToHome("")).toBeNull();
    expect(confineToHome("relative/path")).toBeNull();
    expect(confineToHome("home/user/x")).toBeNull();
    expect(confineToHome(`/home/user/${"a".repeat(2000)}`)).toBeNull();
  });

  it("honors a custom maxLen", () => {
    const p = "/home/user/short";
    expect(confineToHome(p, { maxLen: 5 })).toBeNull();
    expect(confineToHome(p, { maxLen: 1000 })).toBe(p);
  });

  it("exposes the home root constant", () => {
    expect(HOME_ROOT).toBe("/home/user");
  });
});

describe("resolveWorkingDirectory (COMP-16 workdir contract)", () => {
  it("treats absent/blank as the box default (undefined, no error)", () => {
    expect(resolveWorkingDirectory(undefined)).toEqual({ workdir: undefined });
    expect(resolveWorkingDirectory("")).toEqual({ workdir: undefined });
    expect(resolveWorkingDirectory("   ")).toEqual({ workdir: undefined });
  });

  it("accepts and normalizes a directory under the home root", () => {
    expect(resolveWorkingDirectory("/home/user")).toEqual({
      workdir: "/home/user",
    });
    expect(resolveWorkingDirectory("/home/user/myproject/")).toEqual({
      workdir: "/home/user/myproject",
    });
    // The COMP-14 attachments bucket is a valid workdir (relative paths "just work").
    expect(resolveWorkingDirectory("/home/user/attachments")).toEqual({
      workdir: "/home/user/attachments",
    });
  });

  it("rejects traversal and absolute escapes with a clear, path-bearing error", () => {
    for (const bad of [
      "/etc",
      "/etc/passwd",
      "/home/user/../etc",
      "/home/user/../../root",
      "/home/user2/secret",
      "relative/path",
    ]) {
      const result = resolveWorkingDirectory(bad);
      expect("error" in result, bad).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("/home/user");
        expect(result.error).toContain(bad);
      }
    }
  });
});
