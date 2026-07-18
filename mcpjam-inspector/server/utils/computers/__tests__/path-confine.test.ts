import { describe, it, expect } from "vitest";
import { confineToHome, HOME_ROOT } from "../path-confine.js";

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
