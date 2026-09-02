import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
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
import { localPackTarget } from "../targets.js";
import * as packDigests from "../pack-digests.generated.js";

let base: string;
let installRoot: string;
let packSource: string;
let realDigest: string;
/**
 * The generated digest table, held as one spy for the whole file.
 *
 * Kept at module scope rather than re-spied per test: a second `vi.spyOn` on a
 * getter that is already mocked is not a defined way to stack mocks, and a test
 * that needs a different table wants to swap the VALUE anyway.
 */
let packRecords: ReturnType<typeof spyOnPackRecords>;

function spyOnPackRecords() {
  return vi.spyOn(packDigests, "PACK_RECORDS", "get");
}

/**
 * A digest table where every target carries a DIFFERENT digest, and only this
 * machine's is the one the fixture pack really hashes to.
 *
 * The distinctness is the point. A table that gave every target the same
 * digest would pass whether the lookup used the right architecture or the
 * wrong one — which is precisely the bug the `<os>-<arch>` keying exists to
 * prevent, so a fixture that cannot tell them apart proves nothing.
 */
function tableFor(treeDigest: string): typeof packDigests.PACK_RECORDS {
  const decoy = (seed: string) => ({
    packVersion: PACK_VERSION,
    // Valid in shape, and not the digest of anything: a lookup that finds one
    // of these instead of the real entry refuses, loudly.
    treeDigest: `sha256:${seed.repeat(64).slice(0, 64)}`,
  });
  const byTarget: Record<string, { packVersion: string; treeDigest: string }> = {
    "darwin-arm64": decoy("a"),
    "darwin-x64": decoy("b"),
    "linux-x64": decoy("c"),
    "linux-arm64": decoy("d"),
    "win32-x64": decoy("e"),
  };
  byTarget[PLATFORM_KEY] = { packVersion: PACK_VERSION, treeDigest };
  return {
    "claude-code": byTarget,
    codex: {},
  } as typeof packDigests.PACK_RECORDS;
}

const PACK_VERSION = "test-pack-1";
const PLATFORM_KEY = packPlatformKey();

/**
 * Build a miniature but structurally real pack: the files a pack must have,
 * tarred the way the build script tars one, with a manifest beside it.
 */
async function buildFixturePack(
  dir: string,
  opts: {
    extraFile?: string;
    withSymlink?: boolean;
    withHardLink?: boolean;
  } = {},
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

  if (opts.withHardLink === true) {
    // What pnpm leaves behind: two paths, one inode. The digest walk sees two
    // regular files; GNU tar sees the second as a link to the first.
    await link(join(packRoot, "package.json"), join(packRoot, "linked.json"));
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
      // Deliberately no `--hard-dereference`: the fixture archives the way GNU
      // tar does by default, which is the behaviour the build script has to
      // defend against.
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let savedRuntimeRoot: string | undefined;
let savedPackSource: string | undefined;

beforeAll(async () => {
  savedRuntimeRoot = process.env.MCPJAM_RUNTIME_ROOT;
  savedPackSource = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-install-")));
  installRoot = join(base, "runtime");
  packSource = join(base, "source");
  process.env.MCPJAM_RUNTIME_ROOT = installRoot;

  const built = await buildFixturePack(packSource);
  realDigest = built.digest;
  process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = built.archive;

  // The generated digest table is empty in the repo until the pack build runs,
  // so the fixture stands in for what that build would have written.
  packRecords = spyOnPackRecords();
  packRecords.mockReturnValue(tableFor(realDigest));
});

afterEach(async () => {
  await rm(installRoot, { recursive: true, force: true });
});

afterAll(async () => {
  // Restored, not deleted: these are real overrides a developer may have set
  // in their shell, and a suite that silently unsets them changes the machine
  // it ran on.
  restoreEnv("MCPJAM_RUNTIME_ROOT", savedRuntimeRoot);
  restoreEnv("MCPJAM_LOCAL_HARNESS_PACK_SOURCE", savedPackSource);
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

describe("where a pack lives", () => {
  it("honours the Electron-supplied runtime root", () => {
    expect(runtimeInstallRoot()).toBe(installRoot);
    // Under a TARGET segment: an arm64 and a Rosetta x64 Inspector share a
    // home directory, and the same version of two different artifacts must not
    // activate at the same path.
    expect(packVersionRoot("7")).toBe(join(installRoot, PLATFORM_KEY, "7"));
  });

  it("keeps two architectures of one version apart on disk", () => {
    expect(packVersionRoot("7", "darwin-arm64")).not.toBe(
      packVersionRoot("7", "darwin-x64"),
    );
    expect(packVersionRoot("7", "darwin-arm64")).toBe(
      join(installRoot, "darwin-arm64", "7"),
    );
  });

  it("refuses a target no pack is built for", () => {
    // A machine nobody builds for resolves the same way a missing directory
    // does — `unsupported-platform`, not a download that could never verify.
    expect(expectedPackFor("claude-code", "linux-x64")).not.toBeNull();
    expect(localPackTarget("linux", "riscv64")).toBeNull();
  });

  it("does not find one architecture's digest under another's key", () => {
    // The lookup this keying exists for. Every target carries a distinct
    // digest, so a mis-keyed lookup returns the wrong one rather than
    // accidentally the right one.
    const mine = expectedPackFor("claude-code", PLATFORM_KEY as never);
    const others = (["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const)
      .filter((target) => target !== PLATFORM_KEY)
      .map((target) => expectedPackFor("claude-code", target)?.treeDigest);
    expect(mine?.treeDigest).toBe(realDigest);
    expect(others).not.toContain(realDigest);
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
    // `toBe`, not `toEqual`: two separate extractions would produce two
    // structurally equal results and pass, which is the exact failure this
    // test exists to detect. One object means one install.
    expect(a).toBe(b);
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

  it("strips a symlink during extraction and still installs", async () => {
    // Named for what actually happens. Extraction is where a link would do
    // its damage, so it is filtered out THERE rather than written and then
    // caught by the digest — and because the fixture adds the link after
    // taking its digest, the tree that lands still hashes correctly and the
    // install completes without it.
    //
    // There is deliberately no sibling test for a link present BEFORE the
    // digest: `computeTreeDigest` refuses to hash a tree containing one at
    // all (asserted in `runtime-identity.test.ts`), so such a pack cannot be
    // built, and an archive carrying one still cannot produce a matching tree
    // because the extractor drops it — which the digest-mismatch test above
    // already covers. Two independent refusals, neither of which this fixture
    // can express.
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

  it("refuses an archive that deduplicated files into hardlink entries", async () => {
    // The bug that made every real install fail, pinned as a test.
    //
    // pnpm hardlinks out of its store, so a staged pack has hundreds of paths
    // sharing an inode; tar records the later ones as hardlink entries; the
    // extractor accepts only regular files and directories, so they never
    // land. The tree that results is missing files and cannot hash to the
    // digest the manifest names — which is what this asserts, because a
    // refusal is the correct behaviour for an archive shaped like that.
    //
    // The fix is upstream, in `flattenHardLinks` (see its own test): the
    // ARCHIVE must not be shaped like this in the first place.
    const linkDir = join(base, "hardlinked");
    const linked = await buildFixturePack(linkDir, { withHardLink: true });
    const saved = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = linked.archive;
    // The fixture's own digest is what the table would carry for it, so the
    // mismatch this asserts is caused by extraction and nothing else.
    packRecords.mockReturnValue(tableFor(linked.digest));
    try {
      const result = await installRuntimePack({ harnessId: "claude-code" });
      expect(result.state).toBe("corrupt");
      expect((result as { message: string }).message).toMatch(
        /does not match the digest this Inspector was built with/,
      );
    } finally {
      packRecords.mockReturnValue(tableFor(realDigest));
      process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = saved!;
    }
  });

  it("reports a platform with no pack rather than pretending one exists", async () => {
    await expect(
      readRuntimeInstallStatus({ harnessId: "codex" }),
    ).resolves.toMatchObject({ state: "unsupported-platform" });
    expect(expectedPackFor("codex", "linux-x64")).toBeNull();
  });
});
