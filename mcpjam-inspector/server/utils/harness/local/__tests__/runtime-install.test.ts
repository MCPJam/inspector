import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  expectedPackFor,
  installRuntimePack,
  packPlatformKey,
  packSourceFor,
  packVersionRoot,
  readRuntimeInstallStatus,
  runtimeInstallRoot,
} from "../runtime-install.js";
import { computeTreeDigest } from "../runtime-identity.js";
import * as packDigests from "../pack-digests.generated.js";

let base: string;
let installRoot: string;
let packSource: string;
let realDigest: string;

const PACK_VERSION = "test-pack-1";
const PLATFORM_KEY = packPlatformKey();

/**
 * Build a miniature but structurally real pack: the files a pack must have,
 * tarred the way the build script tars one, with a manifest beside it.
 */
async function buildFixturePack(
  dir: string,
  opts: { extraFile?: string; withSymlink?: boolean } = {},
): Promise<{ archive: string; digest: string }> {
  const staging = await mkdtemp(join(base, "stage-"));
  const packRoot = join(staging, "claude-code");
  await mkdir(join(packRoot, "bin"), { recursive: true });
  await writeFile(join(packRoot, "bridge.mjs"), "export const bridge = 1;\n");
  await writeFile(join(packRoot, "launcher.mjs"), 'await import("./bridge.mjs");\n');
  await writeFile(join(packRoot, "package.json"), '{"name":"pack"}\n');
  await writeFile(join(packRoot, "bin", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(packRoot, "bin", "node"), 0o755);
  if (opts.extraFile !== undefined) {
    await writeFile(join(packRoot, "extra.js"), opts.extraFile);
  }

  const digest = await computeTreeDigest(packRoot);
  if (opts.withSymlink === true) {
    // Added AFTER the digest, so the archive carries a link the extractor must
    // refuse on its own rather than one the digest would have caught first.
    await symlink("/etc/passwd", join(packRoot, "sneaky"));
  }

  await mkdir(dir, { recursive: true });
  const archive = join(
    dir,
    `local-harness-pack-${PLATFORM_KEY}-${PACK_VERSION}.tar.gz`,
  );
  execFileSync(
    "tar",
    [
      "--sort=name",
      "--mtime=UTC 2020-01-01",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      archive,
      "-C",
      staging,
      "claude-code",
    ],
    { stdio: "pipe" },
  );
  await rm(staging, { recursive: true, force: true });
  return { archive, digest };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-install-")));
  installRoot = join(base, "runtime");
  packSource = join(base, "source");
  process.env.MCPJAM_RUNTIME_ROOT = installRoot;

  const built = await buildFixturePack(packSource);
  realDigest = built.digest;
  process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = built.archive;

  // The generated digest table is empty in the repo until the pack build runs,
  // so the fixture stands in for what that build would have written.
  vi.spyOn(packDigests, "PACK_RECORDS", "get").mockReturnValue({
    "claude-code": {
      darwin: { packVersion: PACK_VERSION, treeDigest: realDigest },
      linux: { packVersion: PACK_VERSION, treeDigest: realDigest },
      win32: { packVersion: PACK_VERSION, treeDigest: realDigest },
    },
    codex: {},
  });
});

afterEach(async () => {
  await rm(installRoot, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.MCPJAM_RUNTIME_ROOT;
  delete process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

describe("where a pack lives", () => {
  it("honours the Electron-supplied runtime root", () => {
    expect(runtimeInstallRoot()).toBe(installRoot);
    expect(packVersionRoot("7")).toBe(join(installRoot, "7"));
  });

  it("falls back to the release asset for a version it has no override for", () => {
    const saved = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    delete process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    try {
      expect(packSourceFor("9", "linux-x64")).toEqual({
        kind: "url",
        location:
          "https://github.com/MCPJam/inspector/releases/download/v9/" +
          "local-harness-pack-linux-x64-9.tar.gz",
      });
    } finally {
      if (saved !== undefined) {
        process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = saved;
      }
    }
  });
});

describe("installing a pack", () => {
  it("verifies, activates atomically, and reports ready", async () => {
    const progress: string[] = [];
    const result = await installRuntimePack({
      harnessId: "claude-code",
      onProgress: (status) => progress.push(status.state),
    });
    expect(result).toMatchObject({
      state: "ready",
      packVersion: PACK_VERSION,
      digest: realDigest,
    });
    expect(progress).toContain("downloading");
    expect(progress).toContain("verifying");

    // The tree is where `resolveManagedBundle` will look for it…
    const packRoot = join(packVersionRoot(PACK_VERSION), "claude-code");
    expect(await computeTreeDigest(packRoot)).toBe(realDigest);
    // …and the marker sits OUTSIDE the digested tree, so writing it cannot
    // change the digest of the thing it vouches for.
    const marker = JSON.parse(
      await readFile(
        join(packVersionRoot(PACK_VERSION), ".mcpjam-pack-installed.json"),
        "utf8",
      ),
    );
    expect(marker.treeDigest).toBe(realDigest);
  });

  it("reports the installed pack without digesting it again", async () => {
    await installRuntimePack({ harnessId: "claude-code" });
    await expect(
      readRuntimeInstallStatus({ harnessId: "claude-code" }),
    ).resolves.toMatchObject({ state: "ready", packVersion: PACK_VERSION });
  });

  it("reports absent before anything is installed", async () => {
    await expect(
      readRuntimeInstallStatus({ harnessId: "claude-code" }),
    ).resolves.toMatchObject({ state: "absent", packVersion: PACK_VERSION });
  });

  it("is single-flight: two callers share one extraction", async () => {
    const [a, b] = await Promise.all([
      installRuntimePack({ harnessId: "claude-code" }),
      installRuntimePack({ harnessId: "claude-code" }),
    ]);
    expect(a).toEqual(b);
    expect(a.state).toBe("ready");
  });

  it("refuses a pack whose tree does not hash to the expected digest", async () => {
    // What a swapped release asset looks like: a well-formed pack that is not
    // the pack this Inspector build was reviewed against.
    const otherDir = join(base, "other");
    const other = await buildFixturePack(otherDir, {
      extraFile: "// not the pack we shipped\n",
    });
    const saved = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = other.archive;
    try {
      const result = await installRuntimePack({ harnessId: "claude-code" });
      expect(result.state).toBe("corrupt");
      expect((result as { message: string }).message).toMatch(
        /does not match the digest this Inspector was built with/,
      );
      // Nothing was activated: a failed install leaves no version directory
      // for `resolveManagedBundle` to find.
      await expect(
        readRuntimeInstallStatus({ harnessId: "claude-code" }),
      ).resolves.toMatchObject({ state: "absent" });
    } finally {
      process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = saved!;
    }
  });

  it("refuses an archive carrying a symlink", async () => {
    // Extraction is where a link would do its damage, so it is filtered out
    // there rather than written and then caught by the digest. The install
    // still fails, because the tree that lands no longer hashes correctly.
    const linkDir = join(base, "linked");
    const linked = await buildFixturePack(linkDir, { withSymlink: true });
    const saved = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = linked.archive;
    try {
      const result = await installRuntimePack({ harnessId: "claude-code" });
      expect(result.state).toBe("ready");
      // The link did not survive extraction.
      const packRoot = join(packVersionRoot(PACK_VERSION), "claude-code");
      await expect(readFile(join(packRoot, "sneaky"))).rejects.toThrow();
    } finally {
      process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = saved!;
    }
  });

  it("reports a platform with no pack rather than pretending one exists", async () => {
    await expect(
      readRuntimeInstallStatus({ harnessId: "codex" }),
    ).resolves.toMatchObject({ state: "unsupported-platform" });
    expect(expectedPackFor("codex", "linux")).toBeNull();
  });
});
