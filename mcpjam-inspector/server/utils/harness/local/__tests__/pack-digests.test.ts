import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The pack build script, imported for its digest implementation. It only runs
// its `main()` when it is the entry point, so importing it is side-effect free.
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import { computeTreeDigest as buildScriptDigest } from "../../../../../scripts/build-local-harness-pack.mjs";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import {
  EXPECTED_PACK_VERSION,
  PACK_RECORDS,
  PACK_TREE_DIGESTS,
} from "../pack-digests.generated.js";
import { computeTreeDigest } from "../runtime-identity.js";

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

describe("the generated digest table", () => {
  it("has an entry shape the manifest and installer can both read", () => {
    for (const [harnessId, byPlatform] of Object.entries(PACK_RECORDS)) {
      for (const [platform, record] of Object.entries(byPlatform)) {
        expect(record.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(record.packVersion.length).toBeGreaterThan(0);
        // The two tables are generated together and must not disagree: the
        // manifest reads one, the installer reads the other.
        expect(PACK_TREE_DIGESTS[harnessId as "claude-code"][
          platform as "linux"
        ]).toBe(record.treeDigest);
      }
    }
  });

  it("stays in step with the manifest, so no platform claims a pack it has none for", () => {
    // The freshness ratchet. A manifest that lists a platform as native while
    // no pack exists for it would resolve `bundle-absent` at runtime — an
    // honest refusal, but one the user only discovers after consenting. This
    // fails the build instead.
    for (const manifest of Object.values(LOCAL_HARNESS_MANIFEST)) {
      if (manifest.runtime.source !== "managed-bundle") continue;
      expect(manifest.runtime.bundleDigest).toEqual(
        PACK_TREE_DIGESTS[manifest.harnessId],
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
