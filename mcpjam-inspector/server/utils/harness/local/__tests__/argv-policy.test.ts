import { describe, expect, it } from "vitest";
import {
  ArgvPolicyViolation,
  DENIED_ARGV_CAPABILITIES,
  assertArgumentAllowed,
  assertArgvAllowed,
} from "../argv-policy.js";

describe("argv structure", () => {
  it("passes ordinary structured arguments through unchanged", () => {
    const args = ["/opt/bundle/bridge.mjs", "--workdir", "/home/dev/project"];
    expect(assertArgvAllowed(args)).toBe(args);
  });

  it.each([
    ["a semicolon", "a;rm -rf /"],
    ["a pipe", "a|b"],
    ["an ampersand", "a&b"],
    ["a backtick", "`whoami`"],
    ["a dollar", "$(id)"],
    ["a redirect", "out>/etc/passwd"],
    ["a newline", "a\nb"],
    ["a NUL", "a\0b"],
  ])(
    "rejects %s, because it means the caller built this from a string",
    (_l, arg) => {
      expect(() => assertArgumentAllowed(arg)).toThrow(ArgvPolicyViolation);
    },
  );

  it("rejects an empty argument", () => {
    expect(() => assertArgumentAllowed("")).toThrow(ArgvPolicyViolation);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
  ])("rejects %s reaching the policy at runtime", (_label, value) => {
    // The type says string; the check exists because a value can arrive from
    // JSON, a test double, or a future caller the compiler never saw.
    expect(() => assertArgumentAllowed(value as unknown as string)).toThrow(
      ArgvPolicyViolation,
    );
  });

  it("rejects an argument longer than any real path", () => {
    expect(() => assertArgumentAllowed("/x".repeat(4000))).toThrow(
      /exceeds 4096/,
    );
  });

  it("rejects an implausibly long argv", () => {
    expect(() =>
      assertArgvAllowed(Array.from({ length: 65 }, () => "-x")),
    ).toThrow(/max 64/);
  });
});

describe("permission-bypass capabilities", () => {
  it.each([...DENIED_ARGV_CAPABILITIES])("denies %s", (flag) => {
    expect(() => assertArgumentAllowed(flag)).toThrow(ArgvPolicyViolation);
  });

  it("denies a bypass flag regardless of case", () => {
    expect(() =>
      assertArgumentAllowed("--Dangerously-Skip-Permissions"),
    ).toThrow(/disables the vendor permission controls/);
  });

  it("denies a bypass hidden in the value half of --flag=value", () => {
    expect(() => assertArgumentAllowed("--sandbox=danger-full-access")).toThrow(
      ArgvPolicyViolation,
    );
  });

  it("still allows a legitimate flag that merely shares a prefix", () => {
    expect(() => assertArgumentAllowed("--sandbox-report")).not.toThrow();
    expect(() =>
      assertArgumentAllowed("--permission-mode=allow-edits"),
    ).not.toThrow();
  });

  it("reports which rule a rejection came from", () => {
    try {
      assertArgumentAllowed("--yolo");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ArgvPolicyViolation).rule).toBe("capability");
    }
  });

  // Only pairs whose VALUE is not itself on the single-argument denylist
  // actually exercise the separated-form check. `--sandbox danger-full-access`
  // would pass on the value alone, so it proves nothing about the pair logic.
  it.each([
    ["--ask-for-approval", "never"],
    ["--approval-policy", "never"],
  ])("denies the separated form %s %s", (flag, value) => {
    expect(() => assertArgumentAllowed(flag)).not.toThrow();
    expect(() => assertArgumentAllowed(value)).not.toThrow();
    expect(() => assertArgvAllowed(["/opt/b.mjs", flag, value])).toThrow(
      /disables the vendor permission controls/,
    );
  });

  it.each([["--ask-for-approval=never"], ["--approval-policy=never"]])(
    "denies the equals spelling %s too",
    (arg) => {
      // A vendor must not be able to slip past the pair check with an `=`.
      expect(() => assertArgvAllowed(["/opt/b.mjs", arg])).toThrow(
        /disables the vendor permission controls/,
      );
    },
  );

  it("still allows a legitimate value after one of those flags", () => {
    expect(() =>
      assertArgvAllowed(["/opt/b.mjs", "--permission-mode", "allow-edits"]),
    ).not.toThrow();
  });

  it("locks the denylist against silent shrinkage", () => {
    // Adding an entry is free. Removing one re-opens a permission bypass, and
    // that must be a visible edit to this expectation, not a quiet diff in the
    // array above it.
    expect(DENIED_ARGV_CAPABILITIES).toContain(
      "--dangerously-skip-permissions",
    );
    expect(DENIED_ARGV_CAPABILITIES).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(DENIED_ARGV_CAPABILITIES).toContain("danger-full-access");
    expect(DENIED_ARGV_CAPABILITIES).toContain("--yolo");
    expect(DENIED_ARGV_CAPABILITIES.length).toBeGreaterThanOrEqual(14);
  });
});
