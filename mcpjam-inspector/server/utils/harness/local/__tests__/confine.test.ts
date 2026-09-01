import { mkdtemp, mkdir, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathConfinementError, confinePath } from "../confine.js";

let workspace: string;
let stateDir: string;
let outside: string;
let roots: string[];

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-confine-")));
  workspace = join(base, "workspace");
  stateDir = join(base, "state");
  outside = join(base, "outside");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "ok");
  await writeFile(join(outside, "secret.txt"), "shh");
  roots = [workspace, stateDir];
});

afterAll(() => {
  // The temp tree is left to the OS; nothing here is worth a recursive rm in
  // a test that also exercises symlink escapes.
});

describe("confinePath", () => {
  it("allows an existing file inside a granted root", async () => {
    await expect(confinePath(join(workspace, "src", "a.ts"), { roots })).resolves.toBe(
      join(workspace, "src", "a.ts")
    );
  });

  it("allows a file that does not exist yet inside a granted root", async () => {
    await expect(
      confinePath(join(workspace, "src", "nested", "new.ts"), { roots })
    ).resolves.toBe(join(workspace, "src", "nested", "new.ts"));
  });

  it("allows the second granted root too", async () => {
    await expect(confinePath(join(stateDir, "home", "x"), { roots })).resolves.toBe(
      join(stateDir, "home", "x")
    );
  });

  it("rejects a plain path outside every root", async () => {
    await expect(confinePath(join(outside, "secret.txt"), { roots })).rejects.toThrow(
      PathConfinementError
    );
  });

  it("rejects a literal `..` segment, unnormalized", async () => {
    // Built as a raw string on purpose: `path.join` collapses `..` before the
    // value is ever passed, so the joined form only re-tests the plain
    // outside-the-root case and says nothing about traversal.
    await expect(
      confinePath(`${workspace}/../outside/secret.txt`, { roots })
    ).rejects.toThrow(PathConfinementError);
    await expect(
      confinePath(`${workspace}/src/../../outside/secret.txt`, { roots })
    ).rejects.toThrow(PathConfinementError);
  });

  it("rejects an empty path", async () => {
    await expect(confinePath("", { roots })).rejects.toThrow(
      PathConfinementError
    );
  });

  it("does not drop a character when the parent is the filesystem root", async () => {
    // `/ttmp/x` must not be able to resolve to `/tmp/x`: the ancestor walk
    // slices the segment off its parent, and adding a separator offset when
    // the parent already ends in one eats the segment's first character.
    await expect(
      confinePath("/ttmp/definitely-not-here", { roots })
    ).rejects.toThrow(PathConfinementError);
  });

  it("rejects a read THROUGH a symlink that leaves the root", async () => {
    // The case pure string normalization cannot see: every character of this
    // path is inside the workspace.
    await symlink(outside, join(workspace, "escape"));
    await expect(
      confinePath(join(workspace, "escape", "secret.txt"), { roots })
    ).rejects.toThrow(PathConfinementError);
  });

  it("rejects a WRITE through a symlinked parent to a file that does not exist", async () => {
    await symlink(outside, join(workspace, "escape-write"));
    await expect(
      confinePath(join(workspace, "escape-write", "planted.txt"), { roots })
    ).rejects.toThrow(PathConfinementError);
  });

  it("allows a symlink that stays inside the root", async () => {
    await symlink(join(workspace, "src"), join(workspace, "src-link"));
    await expect(
      confinePath(join(workspace, "src-link", "a.ts"), { roots })
    ).resolves.toBe(join(workspace, "src", "a.ts"));
  });

  it("rejects a relative path rather than resolving it against a cwd", async () => {
    await expect(confinePath("relative/path", { roots })).rejects.toThrow(
      /must be absolute/
    );
  });

  it("rejects a NUL byte without echoing the path back", async () => {
    await expect(confinePath("/tmp/a\0b", { roots })).rejects.toThrow(/NUL byte/);
  });

  it("rejects when no root is configured", async () => {
    await expect(confinePath("/tmp/x", { roots: [] })).rejects.toThrow(
      /no writable root/
    );
  });

  it("does not leak the resolved target in its message", async () => {
    try {
      await confinePath(join(outside, "secret.txt"), { roots });
      expect.unreachable("should have thrown");
    } catch (error) {
      // A message naming what the path resolved to would be a filesystem
      // oracle for anything that can see the error.
      expect((error as Error).message).not.toContain("secret.txt");
      expect((error as Error).message).toMatch(/outside every directory/);
    }
  });
});
