/**
 * The canonical tree digest every runtime pack and every Inspector layer is
 * identified by.
 *
 * Its own module because it is a SHARED PACK INPUT: the bytes of this file
 * decide what every pack digests as, so `check-local-harness-inputs.mjs`
 * fingerprints it for every harness. It used to live in `runtime-identity.ts`,
 * which made every edit to runtime RESOLUTION (layers, selection, launch
 * identity) look like a change to every pack and demand a republication of
 * bytes that could not have moved. Nothing here may depend on a harness, a
 * policy or a path layout; that is what keeps it stable.
 *
 * `scripts/build-local-harness-pack.mjs` carries a byte-for-byte duplicate of
 * the walk (it is plain ESM run by a bare Node in CI), and `pack-digests.test.ts`
 * builds a fixture with both and asserts they agree.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Cap on the tree the digest will walk. A pack is a bridge runtime plus a
 *  vendor CLI; anything past this is not an artifact we shipped. */
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * One entry of a tree's stat snapshot: everything a cheap re-check can compare
 * without reading a byte of content. See `runtime-identity.ts` for why `ino`
 * and `ctimeMs` carry the check.
 */
export interface TreeEntrySnapshot {
  /** Path relative to the tree root, POSIX separators. */
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  mode: number;
}

export interface TreeWalkResult {
  digest: string;
  entries: TreeEntrySnapshot[];
  /** Content digests (hex) of the paths `baseline` selected, from the same
   *  read the tree digest hashed. */
  baselineDigests: Record<string, string>;
}

/**
 * Walk a tree once, producing its digest, a stat snapshot, and content
 * digests of the files `baseline` selects.
 *
 * Deterministic across machines: entries are sorted by name at each level, and
 * each contributes path, type, executable bit, size, and content hash. The
 * executable bit is in the digest deliberately — flipping a data file to
 * executable is a meaningful change to what a tree can do.
 *
 * Symlinks are a HARD failure rather than being followed or recorded: a pack
 * is data we built, a link inside it is not something we ship, and following
 * one would let a link planted in the runtime root read or execute outside it.
 */
export async function walkTree(
  root: string,
  baseline: (relativePath: string) => boolean = () => false,
): Promise<TreeWalkResult> {
  const hash = createHash("sha256");
  const entriesSnapshot: TreeEntrySnapshot[] = [];
  const baselineDigests: Record<string, string> = {};
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(
          `managed runtime bundle contains a symlink at ${rel}; bundles are ` +
            `built as plain files so their digest describes exactly what runs`,
        );
      }
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `managed runtime bundle contains a non-regular file at ${rel}`,
        );
      }
      if (++files > MAX_TREE_FILES) {
        throw new Error("managed runtime bundle exceeds the file-count ceiling");
      }
      const info = await stat(full);
      bytes += info.size;
      if (bytes > MAX_TREE_BYTES) {
        throw new Error("managed runtime bundle exceeds the size ceiling");
      }
      const content = await readFile(full);
      const executable = (info.mode & 0o111) !== 0 ? "1" : "0";
      const contentDigest = createHash("sha256").update(content).digest();
      hash.update(`f\0${rel}\0${executable}\0${info.size}\0`);
      hash.update(contentDigest);
      entriesSnapshot.push({
        path: rel,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: Number(info.ino),
        mode: info.mode,
      });
      if (baseline(rel)) baselineDigests[rel] = contentDigest.toString("hex");
    }
  };

  await walk(root);
  return {
    digest: `sha256:${hash.digest("hex")}`,
    entries: entriesSnapshot,
    baselineDigests,
  };
}

/** Canonical tree digest of a directory. */
export async function computeTreeDigest(root: string): Promise<string> {
  return (await walkTree(root)).digest;
}

/** One file of a tree that exists only in memory. */
export interface VirtualTreeFile {
  /** Relative path, POSIX separators, no `.`/`..` segments. */
  path: string;
  content: string | Uint8Array;
  /** Whether the file will carry an execute bit on disk. */
  executable?: boolean;
}

/**
 * The digest `computeTreeDigest` WOULD report for a directory holding exactly
 * these files — computed without touching the disk.
 *
 * This is how the Inspector knows the digest of its own layer before (and
 * independently of) writing it: the expected value is derived from the bytes
 * compiled into this build, and the on-disk copy is then checked against it.
 */
export function digestFileSet(files: readonly VirtualTreeFile[]): string {
  interface Dir {
    dirs: Map<string, Dir>;
    files: Map<string, VirtualTreeFile>;
  }
  const rootDir: Dir = { dirs: new Map(), files: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`not a canonical relative path: ${JSON.stringify(file.path)}`);
    }
    let dir = rootDir;
    for (const part of parts.slice(0, -1)) {
      if (dir.files.has(part)) throw new Error(`${file.path} nests under a file`);
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { dirs: new Map(), files: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    const name = parts[parts.length - 1]!;
    if (dir.files.has(name) || dir.dirs.has(name)) {
      throw new Error(`duplicate path ${file.path}`);
    }
    dir.files.set(name, file);
  }

  const hash = createHash("sha256");
  const walk = (dir: Dir, prefix: string): void => {
    const names = [...dir.dirs.keys(), ...dir.files.keys()].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const sub = dir.dirs.get(name);
      if (sub !== undefined) {
        hash.update(`d\0${rel}\0`);
        walk(sub, rel);
        continue;
      }
      const file = dir.files.get(name)!;
      const bytes =
        typeof file.content === "string"
          ? Buffer.from(file.content, "utf8")
          : Buffer.from(file.content);
      hash.update(`f\0${rel}\0${file.executable ? "1" : "0"}\0${bytes.length}\0`);
      hash.update(createHash("sha256").update(bytes).digest());
    }
  };
  walk(rootDir, "");
  return `sha256:${hash.digest("hex")}`;
}
