import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The pack build script, imported for its digest implementation. It only runs
// its `main()` when it is the entry point, so importing it is side-effect free.
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import {
  computeTreeDigest as buildScriptDigest,
  flattenHardLinks,
} from "../../../../../scripts/build-local-harness-pack.mjs";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import {
  EXPECTED_PACK_VERSION,
  PACK_RECORDS,
  PACK_TREE_DIGESTS,
} from "../pack-digests.generated.js";
import { computeTreeDigest } from "../runtime-identity.js";
import type { LocalPackTarget } from "../targets.js";

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-packdigest-")));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("the pack build and the server agree on what a digest is", () => {
  it("produces the same digest for the same tree", async () => {
    // The build script duplicates `computeTreeDigest` because it is plain ESM
    // run by a bare Node in CI and cannot import the server's TypeScript. That
    // duplication is only safe if something proves the two agree — a drift
    // here would mean CI records a digest no Inspector can ever match, and
    // every install would fail verification with no obvious cause.
    const root = join(base, "tree");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "node_modules", "@scope", "pkg"), {
      recursive: true,
    });
    await writeFile(join(root, "bridge.mjs"), "export const a = 1;\n");
    await writeFile(join(root, "launcher.mjs"), "import './bridge.mjs';\n");
    await writeFile(join(root, "bin", "node"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "bin", "node"), 0o755);
    await writeFile(
      join(root, "node_modules", "@scope", "pkg", "index.js"),
      "module.exports = 1;\n",
    );
    // A file with the same content but no executable bit, because the bit is
    // in the digest and both implementations have to agree that it is.
    await writeFile(join(root, "notnode"), "#!/bin/sh\nexit 0\n");

    expect(buildScriptDigest(root).digest).toBe(await computeTreeDigest(root));
  });

  it("agrees that the executable bit changes the digest", async () => {
    const root = join(base, "mode");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "x"), "same bytes\n");
    const before = buildScriptDigest(root).digest;
    await chmod(join(root, "x"), 0o755);
    const after = buildScriptDigest(root).digest;
    expect(after).not.toBe(before);
    expect(after).toBe(await computeTreeDigest(root));
  });
});

describe("a staged pack has no hardlinks left in it", () => {
  it("gives every shared inode its own file, without changing the digest", async () => {
    // The bug this exists to keep out: pnpm hardlinks out of its store, GNU
    // tar records the later paths as hardlink ENTRIES, and the installer's
    // extractor accepts only regular files and directories — so those files
    // never landed and every install failed its digest check. Found by running
    // the real build and the real installer against a real 494 MB pack, not by
    // reading the code, which is why it is pinned here.
    const root = join(base, "hardlinks");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "shared.js"), "module.exports = 1;\n");
    await chmod(join(root, "shared.js"), 0o755);
    await link(
      join(root, "shared.js"),
      join(root, "node_modules", "pkg", "index.js"),
    );
    expect((await stat(join(root, "shared.js"))).nlink).toBe(2);

    const before = buildScriptDigest(root).digest;
    expect(flattenHardLinks(root)).toBeGreaterThan(0);

    // Two files now, not two names for one file…
    const a = await stat(join(root, "shared.js"));
    const b = await stat(join(root, "node_modules", "pkg", "index.js"));
    expect(a.nlink).toBe(1);
    expect(b.nlink).toBe(1);
    expect(a.ino).not.toBe(b.ino);

    // …with the same bytes and the same mode, so the digest the manifest
    // records is the digest of the tree that was staged.
    expect(await readFile(join(root, "shared.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
    expect(a.mode & 0o777).toBe(0o755);
    expect(buildScriptDigest(root).digest).toBe(before);
    expect(await computeTreeDigest(root)).toBe(before);
  });

  it("leaves a tree that never shared an inode alone", async () => {
    const root = join(base, "no-hardlinks");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.js"), "1\n");
    await writeFile(join(root, "b.js"), "1\n");
    // Same content, separate inodes: dedup is tar's idea, not the tree's.
    expect(flattenHardLinks(root)).toBe(0);
  });
});

describe("the generated digest table", () => {
  it("has an entry shape the manifest and installer can both read", () => {
    for (const [harnessId, byTarget] of Object.entries(PACK_RECORDS)) {
      for (const [target, record] of Object.entries(byTarget)) {
        expect(record.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(record.packVersion.length).toBeGreaterThan(0);
        // The two tables are generated together and must not disagree: the
        // manifest reads one, the installer reads the other.
        expect(
          PACK_TREE_DIGESTS[harnessId as "claude-code"][
            target as LocalPackTarget
          ],
        ).toBe(record.treeDigest);
      }
    }
  });

  it("stays in step with the manifest, so no platform claims a pack it has none for", () => {
    // The freshness ratchet, and it has to assert the REAL invariant rather
    // than that the manifest equals the table it is assigned from — which it
    // does by construction in `compatibility.ts`, and which therefore cannot
    // fail. What can fail, and is what a user would meet, is a manifest that
    // calls a platform native while no pack digest admits any machine of that
    // platform: `resolveManagedBundle` then answers `bundle-absent` after the
    // user has already consented.
    for (const manifest of Object.values(LOCAL_HARNESS_MANIFEST)) {
      if (manifest.runtime.source !== "managed-bundle") continue;
      const targets = Object.keys(manifest.runtime.bundleDigest);
      if (targets.length === 0) {
        // The repo state before any pack build. Every platform then refuses
        // identically at install time ("no runtime pack has been built for
        // darwin-arm64"), which is uniform and honest — and is why the launch
        // checklist makes building the packs a hard release blocker. The
        // ratchet arms itself as soon as the first target lands.
        continue;
      }
      for (const platform of manifest.nativePlatforms) {
        expect(
          targets.filter((target) => target.startsWith(`${platform}-`)),
          `${manifest.harnessId} calls ${platform} native with no pack digest`,
        ).not.toHaveLength(0);
      }
    }
  });

  it("keys the two generated tables identically, in both directions", () => {
    // One table feeds the manifest and the other feeds the installer. A target
    // in only one of them is a machine that either downloads a pack it cannot
    // verify or verifies against a pack it will never download.
    for (const harnessId of Object.keys(PACK_RECORDS) as Array<
      keyof typeof PACK_RECORDS
    >) {
      expect(Object.keys(PACK_RECORDS[harnessId]).sort()).toEqual(
        Object.keys(PACK_TREE_DIGESTS[harnessId]).sort(),
      );
    }
  });

  it("names a pack version whenever it names any digest at all", () => {
    const anyBuilt = Object.values(PACK_RECORDS).some(
      (byPlatform) => Object.keys(byPlatform).length > 0,
    );
    if (!anyBuilt) {
      // The repo state before the pack build has ever run: empty everywhere,
      // and therefore no platform can resolve a runtime.
      expect(EXPECTED_PACK_VERSION).toBe("");
      return;
    }
    expect(EXPECTED_PACK_VERSION.length).toBeGreaterThan(0);
  });
});
