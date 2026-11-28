/**
 * The repository a folder must stay out of, found from the module rather
 * than the working directory, and the folders that count as outside it.
 * Evidence: fixture.
 */
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, isOutsideRepository } from "../outside-repository";

describe("a folder outside the repository", () => {
  it("finds the repository from the package's own manifest, wherever the process runs", () => {
    // This test sits in mcpjam-inspector/server/utils/__tests__.
    const root = REPOSITORY_ROOT;
    if (root === undefined) throw new Error("The package didn't resolve its own manifest.");
    expect(root).toBe(
      resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
    );
    expect(isOutsideRepository(root)).toBe(false);
    expect(
      isOutsideRepository(join(root, "mcpjam-inspector", ".profiles")),
    ).toBe(false);
    expect(isOutsideRepository(join(root, "..", "profiles"))).toBe(true);
  });

  it("tells a sibling folder from one inside whose name starts with dots", () => {
    const outside = (folder: string) =>
      isOutsideRepository(folder, { root: "/work/inspector", paths: posix });
    expect(outside("/work/inspector-profiles")).toBe(true);
    expect(outside("/work")).toBe(true);
    expect(outside("/work/inspector/..profiles")).toBe(false);
    expect(outside("/work/inspector/mcpjam-inspector/profiles")).toBe(false);
  });

  it("counts a folder on another Windows drive as outside", () => {
    const outside = (folder: string) =>
      isOutsideRepository(folder, {
        root: "C:\\work\\inspector",
        paths: win32,
      });
    expect(outside("D:\\profiles\\claude-profile")).toBe(true);
    expect(outside("C:\\Users\\someone\\.mcpjam\\web-clients")).toBe(true);
    expect(outside("C:\\work\\inspector\\profiles")).toBe(false);
  });
});
