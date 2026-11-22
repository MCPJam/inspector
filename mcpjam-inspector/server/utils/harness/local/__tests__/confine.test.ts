import { mkdtemp, mkdir, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathConfinementError, confinePath } from "../confine.js";

// Every link below is a junction. Windows lets any user create one without
// the symlink privilege, so it is the link a model can plant there; POSIX
// ignores the type and creates an ordinary symlink.

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
    await expect(
      confinePath(join(workspace, "src", "a.ts"), { roots }),
    ).resolves.toBe(join(workspace, "src", "a.ts"));
  });

  it("allows a file that does not exist yet inside a granted root", async () => {
    await expect(
      confinePath(join(workspace, "src", "nested", "new.ts"), { roots }),
    ).resolves.toBe(join(workspace, "src", "nested", "new.ts"));
  });

  it("allows the second granted root too", async () => {
    await expect(
      confinePath(join(stateDir, "home", "x"), { roots }),
    ).resolves.toBe(join(stateDir, "home", "x"));
  });

  it("rejects a plain path outside every root", async () => {
    await expect(
      confinePath(join(outside, "secret.txt"), { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("rejects a literal `..` segment, unnormalized", async () => {
    // Built as a raw string on purpose: `path.join` collapses `..` before the
    // value is ever passed, so the joined form only re-tests the plain
    // outside-the-root case and says nothing about traversal.
    await expect(
      confinePath(`${workspace}/../outside/secret.txt`, { roots }),
    ).rejects.toThrow(PathConfinementError);
    await expect(
      confinePath(`${workspace}/src/../../outside/secret.txt`, { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("rejects an empty path", async () => {
    await expect(confinePath("", { roots })).rejects.toThrow(
      PathConfinementError,
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
  ])("rejects %s reaching it past the type system", async (_label, value) => {
    // The contract's callers are adapter-driven, so the guard is a runtime one
    // and not merely a type annotation. A non-string that fell through would
    // reach `normalize` and throw something that is not a confinement refusal.
    await expect(
      confinePath(value as unknown as string, { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("does not drop a character when the parent is the filesystem root", async () => {
    // Discriminating on purpose: the buggy slice turned `/ttmp/x` into
    // `/tmp/x`, so the root set here must CONTAIN the malformed result. With
    // the old offset the path resolved inside `/tmp` and was accepted; with
    // the fix it stays `/ttmp/...` and is rejected. Asserting against a root
    // set that excludes both spellings would pass either way.
    // The top-level directory holding the temp dir: `/tmp` on Linux, a drive's
    // first directory on Windows, where `D:\` ends in a separator the same way.
    const temp = await realpath(tmpdir());
    const { root } = parse(temp);
    const top = join(root, temp.slice(root.length).split(sep)[0]!);
    const name = basename(top);
    await expect(
      confinePath(join(root, `${name[0]}${name}`, "definitely-not-here"), {
        roots: [top],
      }),
    ).rejects.toThrow(PathConfinementError);
    // The same shape one character shorter really is inside, so the test is
    // measuring the slice and not simply a missing directory.
    await expect(
      confinePath(join(top, "definitely-not-here"), { roots: [top] }),
    ).resolves.toBe(join(top, "definitely-not-here"));
  });

  it("rejects a read THROUGH a symlink that leaves the root", async () => {
    // The case pure string normalization cannot see: every character of this
    // path is inside the workspace.
    await symlink(outside, join(workspace, "escape"), "junction");
    await expect(
      confinePath(join(workspace, "escape", "secret.txt"), { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("rejects a WRITE through a symlinked parent to a file that does not exist", async () => {
    await symlink(outside, join(workspace, "escape-write"), "junction");
    await expect(
      confinePath(join(workspace, "escape-write", "planted.txt"), { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("allows a symlink that stays inside the root", async () => {
    await symlink(
      join(workspace, "src"),
      join(workspace, "src-link"),
      "junction",
    );
    await expect(
      confinePath(join(workspace, "src-link", "a.ts"), { roots }),
    ).resolves.toBe(join(workspace, "src", "a.ts"));
  });

  it("rejects a relative path rather than resolving it against a cwd", async () => {
    await expect(confinePath("relative/path", { roots })).rejects.toThrow(
      /must be absolute/,
    );
  });

  it("rejects a NUL byte without echoing the path back", async () => {
    await expect(confinePath("/tmp/a\0b", { roots })).rejects.toThrow(
      /NUL byte/,
    );
  });

  it("rejects when no root is configured", async () => {
    await expect(confinePath("/tmp/x", { roots: [] })).rejects.toThrow(
      /no writable root/,
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

describe("dangling symlinks are links, not absences", () => {
  it("refuses a link whose target does not exist outside the root", async () => {
    // The case a `realpath`-only walk gets wrong: `realpath` FAILS on a link
    // with no target, so the link was classified as "a name that is not there
    // yet" and re-attached literally — landing back inside the root and
    // passing. `open(…, "w")` then follows it and CREATES the target outside.
    // No race is involved; the model can plant this link itself.
    await symlink(
      join(outside, "not-yet.txt"),
      join(workspace, "dangling"),
      "junction",
    );
    await expect(
      confinePath(join(workspace, "dangling"), { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("still allows a dangling link that stays inside the root", async () => {
    await symlink(
      join(workspace, "src", "later.ts"),
      join(workspace, "inside"),
      "junction",
    );
    await expect(
      confinePath(join(workspace, "inside"), { roots }),
    ).resolves.toBe(join(workspace, "src", "later.ts"));
  });

  it("follows a dangling link used as a DIRECTORY component", async () => {
    await symlink(
      join(outside, "nowhere"),
      join(workspace, "dangling-dir"),
      "junction",
    );
    await expect(
      confinePath(join(workspace, "dangling-dir", "child.txt"), { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("follows a chain of dangling links to where it actually lands", async () => {
    await symlink(join(workspace, "hop2"), join(workspace, "hop1"), "junction");
    await symlink(
      join(outside, "end.txt"),
      join(workspace, "hop2"),
      "junction",
    );
    await expect(
      confinePath(join(workspace, "hop1"), { roots }),
    ).rejects.toThrow(PathConfinementError);
  });

  it("refuses a symlink cycle rather than spinning", async () => {
    await symlink(
      join(workspace, "loop-b"),
      join(workspace, "loop-a"),
      "junction",
    );
    await symlink(
      join(workspace, "loop-a"),
      join(workspace, "loop-b"),
      "junction",
    );
    await expect(
      confinePath(join(workspace, "loop-a"), { roots }),
    ).rejects.toThrow(/more than 8 symbolic links/);
  });
});
