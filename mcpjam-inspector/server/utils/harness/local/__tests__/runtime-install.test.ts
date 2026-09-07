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
import { join, resolve } from "node:path";
import { create as createTar, list as listTar } from "tar";
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
 * Is there a GNU tar on this host?
 *
 * Asked ONCE, and used only to gate the suite that tests GNU tar's own
 * PRODUCER behaviour. Everything about the installer — download, signature,
 * archive hash, tree digest, extraction filtering, activation — is tested with
 * fixtures built by the `tar` package this server already depends on, so the
 * core suite runs identically on macOS, Windows and Linux. It used to shell
 * out to `tar --sort=name` unconditionally, which is a GNU flag: the whole
 * file was silently a Linux-only suite for the one component whose bugs are
 * per-platform by construction.
 */
function gnuTarBin(): string | null {
  for (const bin of ["tar", "gtar"]) {
    try {
      const version = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/GNU tar/.test(version)) return bin;
    } catch {
      // Not installed, or too old to answer `--version`; try the next name.
    }
  }
  return null;
}
const GNU_TAR = gnuTarBin();

interface FixtureOptions {
  extraFile?: string;
  withSymlink?: boolean;
  withHardLink?: boolean;
  /** A macOS AppleDouble sibling, as bsdtar would write for an xattr. */
  withAppleDouble?: boolean;
  /** Archive with GNU tar and the build script's own reproducibility flags. */
  useGnuTar?: boolean;
}

/**
 * Stage a miniature but structurally real pack, and return its tree digest.
 *
 * Split from the archiving step so both producers below archive the SAME tree:
 * a fixture whose GNU and node-tar variants staged different bytes could not
 * be used to say anything about the producer.
 */
async function stagePack(
  opts: FixtureOptions,
): Promise<{ staging: string; digest: string }> {
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
    // regular files; a tar that deduplicates sees the second as a link.
    await link(join(packRoot, "package.json"), join(packRoot, "linked.json"));
  }

  const digest = await computeTreeDigest(packRoot);

  // Both of these are added AFTER the digest, so the archive carries something
  // the digest does not vouch for — which is exactly the shape each defends
  // against. A tree containing either could not be digested at all (symlink)
  // or would digest to something else (AppleDouble).
  if (opts.withSymlink === true) {
    await symlink("/etc/passwd", join(packRoot, "sneaky"));
  }
  if (opts.withAppleDouble === true) {
    await writeFile(
      join(packRoot, "._package.json"),
      Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]),
    );
  }

  return { staging, digest };
}

/**
 * Build a fixture pack archive.
 *
 * The default producer is the `tar` package — the same one the installer
 * extracts with, available on every platform this server runs on. It
 * reproduces all three adversarial entry types the extractor has to refuse:
 * `SymbolicLink`, `Link` (a deduplicated hardlink), and an ordinary `File`
 * that should not be in the tree at all.
 */
async function buildFixturePack(
  dir: string,
  opts: FixtureOptions = {},
): Promise<{ archive: string; digest: string }> {
  const { staging, digest } = await stagePack(opts);

  await mkdir(dir, { recursive: true });
  const archive = join(
    dir,
    `local-harness-pack-${PLATFORM_KEY}-${PACK_VERSION}.tar.gz`,
  );

  if (opts.useGnuTar === true) {
    if (GNU_TAR === null) throw new Error("no GNU tar on this host");
    execFileSync(
      GNU_TAR,
      [
        // The build script's own reproducibility flags, so what this asserts
        // is the archive a release actually produces.
        "--sort=name",
        "--mtime=UTC 2020-01-01",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--hard-dereference",
        "-czf",
        archive,
        "-C",
        staging,
        "claude-code",
      ],
      { stdio: "pipe" },
    );
  } else {
    await createTar(
      {
        file: archive,
        gzip: true,
        // ABSOLUTE, and load-bearing. node-tar only emits a `Link` entry when
        // the cached target path starts with `cwd`, so a relative cwd silently
        // turns every hardlink into a second regular file — and the fixture
        // that exists to produce hardlink entries would produce none.
        cwd: resolve(staging),
        // `portable: true` would strip `nlink` from the header and disable
        // that dedup for the same reason.
        portable: false,
        follow: false,
      },
      ["claude-code"],
    );
  }

  await rm(staging, { recursive: true, force: true });
  return { archive, digest };
}

/** The entry types an archive actually carries, so a fixture can be checked
 *  rather than assumed. */
async function archiveEntryTypes(archive: string): Promise<string[]> {
  const types: string[] = [];
  await listTar({ file: archive, onReadEntry: (entry) => types.push(entry.type) });
  return types;
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
    await expect(archiveEntryTypes(linked.archive)).resolves.toContain(
      "SymbolicLink",
    );
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
    // sharing an inode; a tar that deduplicates records the later ones as
    // hardlink entries; the extractor accepts only regular files and
    // directories, so they never land. The tree that results is missing files
    // and cannot hash to the digest the manifest names — which is what this
    // asserts, because a refusal is the correct behaviour for an archive
    // shaped like that.
    //
    // The fix is upstream, in `flattenHardLinks` (see its own test): the
    // ARCHIVE must not be shaped like this in the first place. Nothing here is
    // GNU-specific — the `tar` package this fixture uses deduplicates the same
    // way, which is why this stays in the core suite.
    const linkDir = join(base, "hardlinked");
    const linked = await buildFixturePack(linkDir, { withHardLink: true });
    // The fixture must actually BE adversarial. node-tar only deduplicates
    // when `cwd` is absolute and `portable` is false, and a fixture that
    // quietly wrote two regular files would make this test pass while
    // asserting nothing.
    await expect(archiveEntryTypes(linked.archive)).resolves.toContain("Link");
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

  it("refuses an archive carrying macOS AppleDouble members", async () => {
    // Why `build-local-harness-pack.mjs` sets COPYFILE_DISABLE=1 and then
    // reads its own archive back to check.
    //
    // bsdtar on macOS stores a file's extended attributes as a sibling
    // `._name` member. The tree digest is taken from the staged pack BEFORE
    // archiving, so those members are in the archive and in no digest;
    // extraction produces a tree with extra files and the install refuses the
    // pack it just downloaded. The vendor CLI arrives quarantined, so this was
    // the ordinary macOS case rather than an edge one — and the refusal is
    // correct, which is precisely why the suppression has to happen in the
    // producer.
    const appleDir = join(base, "appledouble");
    const fixture = await buildFixturePack(appleDir, { withAppleDouble: true });
    const saved = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = fixture.archive;
    packRecords.mockReturnValue(tableFor(fixture.digest));
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
});

/**
 * GNU tar as a PRODUCER — the only thing in this file that is genuinely
 * GNU-specific.
 *
 * The release archives with GNU tar's reproducibility flags where one is
 * available, and `--hard-dereference` is what turns a deduplicated tree back
 * into one entry per file. That is a claim about GNU tar's behaviour, so it is
 * tested against GNU tar and skipped where there is none. Everything else
 * about the installer runs on every platform.
 */
describe.skipIf(GNU_TAR === null)("GNU tar as the release producer", () => {
  it("flattens hardlinks with --hard-dereference, so the pack installs", async () => {
    const gnuDir = join(base, "gnu-hardlinked");
    const fixture = await buildFixturePack(gnuDir, {
      withHardLink: true,
      useGnuTar: true,
    });
    const saved = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
    process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = fixture.archive;
    packRecords.mockReturnValue(tableFor(fixture.digest));
    try {
      // The same tree that fails to install from a deduplicating producer
      // installs cleanly from this one — which is the whole reason the release
      // reaches for GNU tar when it can find one.
      const result = await installRuntimePack({ harnessId: "claude-code" });
      expect(result.state).toBe("ready");
      const packRoot = join(packVersionRoot(PACK_VERSION), "claude-code");
      await expect(
        readFile(join(packRoot, "linked.json"), "utf8"),
      ).resolves.toContain("pack");
    } finally {
      packRecords.mockReturnValue(tableFor(realDigest));
      process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = saved!;
    }
  });
});
