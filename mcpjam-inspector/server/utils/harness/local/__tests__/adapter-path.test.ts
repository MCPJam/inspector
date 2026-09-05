import { describe, expect, it } from "vitest";
import {
  AdapterPathError,
  fromAdapterPath,
  isAdapterShapedWindowsPath,
  toAdapterPath,
} from "../adapter-path.js";

describe("adapter-facing paths on POSIX", () => {
  it("are the native path, untouched, in both directions", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(toAdapterPath("/Users/me/.mcpjam/sessions/s1/work", platform)).toBe(
        "/Users/me/.mcpjam/sessions/s1/work",
      );
      expect(fromAdapterPath("/Users/me/.mcpjam/sessions/s1/work", platform)).toBe(
        "/Users/me/.mcpjam/sessions/s1/work",
      );
      // Even a string that LOOKS like an MSYS drive path is left alone off
      // Windows: `/c/...` is a perfectly ordinary directory there.
      expect(fromAdapterPath("/c/Users/x", platform)).toBe("/c/Users/x");
    }
  });
});

describe("adapter-facing paths on Windows", () => {
  it("present a drive-letter path in the MSYS spelling the adapter can resolve", () => {
    expect(
      toAdapterPath("C:\\Users\\runneradmin\\.mcpjam\\sessions\\s1\\work", "win32"),
    ).toBe("/c/Users/runneradmin/.mcpjam/sessions/s1/work");
    // Forward slashes and a trailing separator are normalised away.
    expect(toAdapterPath("D:/a/_temp/conformance/", "win32")).toBe(
      "/d/a/_temp/conformance",
    );
    expect(toAdapterPath("C:\\", "win32")).toBe("/c");
  });

  it("is what the adapter's own POSIX composition then works on", async () => {
    const { posix } = await import("node:path");
    const root = toAdapterPath("C:\\Users\\x\\work", "win32");
    // The two compositions the framework actually performs.
    expect(posix.resolve(root, ".harness-bootstrap/claude-code")).toBe(
      "/c/Users/x/work/.harness-bootstrap/claude-code",
    );
    expect(`${root}/.agent-runs/s1/bridge`).toBe(
      "/c/Users/x/work/.agent-runs/s1/bridge",
    );
    expect(posix.isAbsolute(root)).toBe(true);
  });

  it("maps the adapter's spelling back to the native path", () => {
    expect(fromAdapterPath("/c/Users/x/work/.agent-runs/s1/bridge", "win32")).toBe(
      "C:\\Users\\x\\work\\.agent-runs\\s1\\bridge",
    );
    expect(fromAdapterPath("/c", "win32")).toBe("C:\\");
    expect(fromAdapterPath("/c/", "win32")).toBe("C:\\");
  });

  it("round-trips", () => {
    for (const native of [
      "C:\\Users\\runneradmin\\.mcpjam\\harness-local\\sessions\\conformance-1\\work",
      "D:\\a\\_temp\\conformance\\home",
      "C:\\",
    ]) {
      expect(fromAdapterPath(toAdapterPath(native, "win32"), "win32")).toBe(
        native,
      );
    }
  });

  it("resolves `..` in the adapter's shape before re-seating on the drive", () => {
    expect(fromAdapterPath("/c/Users/x/work/../home", "win32")).toBe(
      "C:\\Users\\x\\home",
    );
    // Climbing above the drive root clamps to the root. Confinement, not this
    // module, is what refuses it.
    expect(fromAdapterPath("/c/../../etc", "win32")).toBe("C:\\etc");
  });

  it("hands back anything that is not an MSYS drive path, unchanged", () => {
    // A native path arriving here (the provider's own overlay paths do) passes
    // straight through to confinement.
    expect(fromAdapterPath("C:\\Users\\x\\bootstrap\\.ok", "win32")).toBe(
      "C:\\Users\\x\\bootstrap\\.ok",
    );
    // Not one of ours: no drive letter to seat it on. Confinement refuses it.
    expect(fromAdapterPath("/tmp/harness/claude-code", "win32")).toBe(
      "/tmp/harness/claude-code",
    );
    expect(fromAdapterPath("/cc/looks/like/a/drive", "win32")).toBe(
      "/cc/looks/like/a/drive",
    );
    expect(fromAdapterPath("relative/path", "win32")).toBe("relative/path");
  });

  it("refuses to invent a POSIX shape for a path that has none", () => {
    expect(() => toAdapterPath("\\\\server\\share\\dir", "win32")).toThrow(
      AdapterPathError,
    );
    expect(() => toAdapterPath("relative\\dir", "win32")).toThrow(
      AdapterPathError,
    );
    expect(() => toAdapterPath("C:relative", "win32")).toThrow(AdapterPathError);
  });

  it("recognises the shape it translates", () => {
    expect(isAdapterShapedWindowsPath("/c/Users")).toBe(true);
    expect(isAdapterShapedWindowsPath("/c")).toBe(true);
    expect(isAdapterShapedWindowsPath("/cc/Users")).toBe(false);
    expect(isAdapterShapedWindowsPath("C:\\Users")).toBe(false);
    expect(isAdapterShapedWindowsPath("/tmp")).toBe(false);
  });
});
