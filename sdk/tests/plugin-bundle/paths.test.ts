/**
 * Path-attack fixtures — every entry on the plan's reject list. Each attack
 * must fail BEFORE component normalization: the source records reads, and we
 * assert none happened when the archive-level validation throws.
 */

import { describe, expect, it } from "vitest";
import {
  parsePluginBundle,
  type PluginFileEntry,
  type PluginIssueCode,
} from "../../src/plugin-bundle/index.js";
// Internal helpers are deliberately not on the public barrel.
import {
  normalizeBundlePath,
  resolveContainedPath,
} from "../../src/plugin-bundle/paths.js";
import {
  bundle,
  expectParseError,
  manifestJson,
  minimalBundle,
} from "./fixtures.js";

const MANIFEST = ".codex-plugin/plugin.json";

async function expectPathAttackFails(
  files: Record<string, string>,
  code: PluginIssueCode,
  entries?: PluginFileEntry[]
): Promise<void> {
  const source = bundle(files, entries ? { entries } : undefined);
  await expectParseError(source, code);
  // Fails before any content read — hence before component normalization.
  expect(source.reads).toEqual([]);
}

describe("plugin bundle path attacks", () => {
  it("rejects absolute POSIX paths", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "/etc/passwd": "boom" },
      "PATH_ABSOLUTE"
    );
  });

  it("rejects absolute Windows paths", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "C:\\windows\\evil.txt": "boom" },
      "PATH_ABSOLUTE"
    );
  });

  it("rejects leading-backslash paths", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "\\\\share\\evil.txt": "boom" },
      "PATH_ABSOLUTE"
    );
  });

  it("rejects `..` traversal (Zip Slip)", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "../outside.txt": "boom" },
      "PATH_TRAVERSAL"
    );
  });

  it("rejects interior `..` traversal", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "skills/../../../outside.txt": "boom" },
      "PATH_TRAVERSAL"
    );
  });

  it("rejects NUL bytes in paths", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "evil\u0000.txt": "boom" },
      "PATH_NUL_BYTE"
    );
  });

  it("rejects control characters in paths", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "evil\nname.txt": "boom" },
      "PATH_INVALID_CHARACTER"
    );
  });

  it("rejects duplicate normalized paths", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson() },
      "PATH_DUPLICATE",
      [
        { path: MANIFEST, size: 10 },
        { path: "a.txt", size: 1 },
        { path: "./a.txt", size: 1 },
      ]
    );
  });

  it("rejects case-fold collisions", async () => {
    await expectPathAttackFails(
      {
        [MANIFEST]: manifestJson(),
        "README.md": "one",
        "readme.MD": "two",
      },
      "PATH_CASE_COLLISION"
    );
  });

  it("rejects symlink entries", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson() },
      "PATH_LINK_ENTRY",
      [
        { path: MANIFEST, size: 10 },
        { path: "link-to-passwd", size: 0, kind: "symlink" },
      ]
    );
  });

  it("rejects hardlink entries", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson() },
      "PATH_LINK_ENTRY",
      [
        { path: MANIFEST, size: 10 },
        { path: "hard-link", size: 0, kind: "hardlink" },
      ]
    );
  });

  it("rejects paths longer than 512 bytes", async () => {
    const long = `${"a".repeat(600)}.txt`;
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), [long]: "boom" },
      "PATH_TOO_LONG"
    );
  });

  it("rejects nesting deeper than 20 segments", async () => {
    const deep = `${Array.from({ length: 22 }, (_, i) => `d${i}`).join(
      "/"
    )}/f.txt`;
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), [deep]: "boom" },
      "PATH_TOO_DEEP"
    );
  });

  it("rejects bundles exceeding the entry-count limit", async () => {
    const source = minimalBundle({
      "a.txt": "a",
      "b.txt": "b",
      "c.txt": "c",
    });
    await expectParseError(source, "BUNDLE_TOO_MANY_ENTRIES", {
      limits: { maxEntries: 3 },
    });
    expect(source.reads).toEqual([]);
  });

  it("rejects files exceeding the per-file limit before reading them", async () => {
    const source = minimalBundle({ "big.bin": "x".repeat(64) });
    await expectParseError(source, "FILE_TOO_LARGE", {
      limits: { maxFileBytes: 32 },
    });
    expect(source.reads).toEqual([]);
  });

  it("rejects bundles exceeding the total-size limit", async () => {
    const source = minimalBundle({
      "a.bin": "x".repeat(40),
      "b.bin": "y".repeat(40),
    });
    await expectParseError(source, "BUNDLE_TOO_LARGE", {
      limits: { maxTotalBytes: 64 },
    });
    expect(source.reads).toEqual([]);
  });

  it("rejects entries whose declared size lies about the content", async () => {
    const source = bundle(
      { [MANIFEST]: manifestJson(), "a.txt": "actual content" },
      {
        entries: [
          { path: MANIFEST, size: manifestJson().length },
          { path: "a.txt", size: 1 }, // declared 1 byte, actual 14
        ],
      }
    );
    await expectParseError(source, "FILE_SIZE_MISMATCH");
  });

  it("rejects empty bundles", async () => {
    await expectParseError(bundle({}), "BUNDLE_EMPTY");
  });

  it("normalizes Windows separators and dot segments", async () => {
    const source = bundle({
      [MANIFEST]: manifestJson(),
      "docs\\readme.md": "hello",
      "./notes.txt": "notes",
    });
    const parsed = await parsePluginBundle(source);
    expect(parsed.manifest.name).toBe("demo-plugin");
  });
});

describe("Windows path quirks", () => {
  it("rejects bare-drive prefixes (C:foo)", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "C:foo.txt": "boom" },
      "PATH_INVALID_CHARACTER"
    );
  });

  it("rejects NTFS alternate-data-stream colons", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "docs/readme.txt:hidden": "boom" },
      "PATH_INVALID_CHARACTER"
    );
  });

  it("rejects segments that collapse to traversal after trailing-space stripping", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), "a/.. /escape.txt": "boom" },
      "PATH_INVALID_CHARACTER"
    );
  });

  it.each(["a/. /x.txt", "a/.../x.txt", "a/ . /x.txt"])(
    "rejects Windows-collapsing segment in %j",
    async (path) => {
      await expectPathAttackFails(
        { [MANIFEST]: manifestJson(), [path]: "boom" },
        "PATH_INVALID_CHARACTER"
      );
    }
  );

  it("still allows ordinary interior dots", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "docs/archive.tar.gz.txt": "ok",
        "docs/v1.2/notes.md": "ok",
      })
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
  });
});

describe("unicode normalization of canonical paths", () => {
  const NFC_PATH = "docs/caf\u00e9.md"; // e-acute as one precomposed code point
  const NFD_PATH = "docs/cafe\u0301.md"; // e + combining acute accent

  it("produces the same bundleHash for NFD and NFC forms of the same path", async () => {
    const nfc = await parsePluginBundle(
      bundle({ [MANIFEST]: manifestJson(), [NFC_PATH]: "hello" })
    );
    const nfd = await parsePluginBundle(
      bundle({ [MANIFEST]: manifestJson(), [NFD_PATH]: "hello" })
    );
    expect(nfd.bundleHash).toBe(nfc.bundleHash);
  });

  it("treats NFD and NFC forms of one path in the same bundle as duplicates", async () => {
    await expectPathAttackFails(
      { [MANIFEST]: manifestJson(), [NFC_PATH]: "one", [NFD_PATH]: "two" },
      "PATH_DUPLICATE"
    );
  });
});

describe("normalizeBundlePath", () => {
  it("canonicalizes separators, dot segments, and duplicate slashes", () => {
    expect(normalizeBundlePath("./a//b\\c/./d.txt")).toEqual({
      ok: true,
      path: "a/b/c/d.txt",
    });
  });

  it.each([
    ["", "PATH_EMPTY"],
    [".", "PATH_EMPTY"],
    ["/abs", "PATH_ABSOLUTE"],
    ["C:/abs", "PATH_ABSOLUTE"],
    ["a/../b", "PATH_TRAVERSAL"],
    ["a\u0000b", "PATH_NUL_BYTE"],
    ["a\tb", "PATH_INVALID_CHARACTER"],
  ] as const)("rejects %j with %s", (raw, code) => {
    const result = normalizeBundlePath(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });
});

describe("resolveContainedPath", () => {
  it("joins a relative reference under the base directory", () => {
    expect(resolveContainedPath("skills/demo", "./refs/a.md")).toEqual({
      ok: true,
      path: "skills/demo/refs/a.md",
    });
  });

  it("maps escapes to PATH_ESCAPES_ROOT", () => {
    for (const ref of ["../up.md", "/abs.md"]) {
      const result = resolveContainedPath("skills/demo", ref);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PATH_ESCAPES_ROOT");
    }
  });
});
