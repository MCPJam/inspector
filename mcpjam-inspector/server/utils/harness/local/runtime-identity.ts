/**
 * Runtime identity — proving WHAT is about to run before consent is granted,
 * and proving it again immediately before spawn.
 *
 * Two acquisition shapes, one output. Both produce a stable `runtimeId` that
 * consent binds to, so replacing the runtime after the user agreed to it
 * invalidates the grant instead of silently launching something else
 * (invariant 3).
 *
 *  - `managed-bundle` — the preferred path for the Vercel Claude/Codex
 *    adapters. CI installs the adapter's own frozen bridge dependency graph,
 *    records a canonical tree digest, and ships it as reviewed package data.
 *    Verification is a full re-digest of the tree against the manifest value.
 *  - `system-install` — for an adapter that intentionally uses a user's own
 *    installation. Discovery is deliberately separate from launch: a candidate
 *    is found, canonicalized, rejected if it lives anywhere the session or the
 *    workspace could have written it, identity-probed, and only then frozen
 *    into a `runtimeId`.
 *
 * `PATH` is not consulted at spawn time by anyone. Discovery may consult a
 * SANITIZED path once, during acquisition; the value that survives is an
 * absolute canonical path plus a file identity, and that is what launches.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { LocalHarnessCompatibility } from "./compatibility.js";
import {
  localPackTarget,
  type LocalPlatform,
  type SupportedLocalHarnessId,
} from "./targets.js";
import { setWindowsJobLauncherVerified } from "./process-identity.js";

/** Cap on the bundle tree the digest will walk. A managed bundle is a bridge
 *  plus a vendor CLI; anything past this is not the artifact we shipped. */
const MAX_BUNDLE_FILES = 50_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
/** Identity probes get a short leash and bounded output. */
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BUFFER = 64 * 1024;

export interface ResolvedRuntime {
  /** Stable identity consent binds to. Changes whenever anything below does. */
  runtimeId: string;
  source: "managed-bundle" | "system-install";
  harnessId: SupportedLocalHarnessId;
  platform: LocalPlatform;
  adapterVersion: string;
  /** Absolute path of the verified bundle root (managed) or executable
   *  (system). Local trusted state only — never sent to a renderer. */
  rootPath: string;
  /** Absolute path of the launcher the supervisor spawns. */
  launcherPath: string;
  /**
   * Absolute path of the Node binary inside the verified pack, which is the
   * ONLY interpreter a bridge is launched with.
   *
   * Absent for a system install, which is launched directly rather than
   * interpreted.
   */
  nodePath?: string;
  /**
   * Windows only: the verified Job Object launcher the supervisor spawns in
   * front of the bridge, so every descendant lands in a job that dies with it.
   *
   * Absent on every other platform, and absent on Windows until a pack ships
   * one — which is exactly when `supportsOwnershipProof('win32')` starts
   * answering true.
   */
  jobLauncherPath?: string;
  /** Tree digest (managed) or file digest (system). */
  digest: string;
  /** Vendor package versions, for display and audit. */
  vendorPackages: Readonly<Record<string, string>>;
  /** Probe stdout for a system install, for display. Absent for a bundle. */
  vendorVersionLine?: string;
}

export type RuntimeResolutionFailure =
  | { status: "bundle-absent"; message: string }
  | { status: "bundle-corrupt"; message: string }
  | { status: "bundle-digest-mismatch"; message: string }
  | { status: "system-runtime-not-installed"; message: string }
  | { status: "system-runtime-ambiguous"; message: string }
  | { status: "system-runtime-untrusted-path"; message: string }
  | { status: "system-runtime-identity-mismatch"; message: string };

export type RuntimeResolution =
  | { ok: true; runtime: ResolvedRuntime }
  | ({ ok: false } & RuntimeResolutionFailure);

/**
 * Canonical tree digest of a directory.
 *
 * Deterministic across machines: entries are sorted by their POSIX-normalized
 * relative path, and each contributes path, type, executable bit, size, and
 * content hash. The executable bit is in the digest deliberately — flipping a
 * data file to executable is a meaningful change to what a bundle can do, and
 * a content-only digest would not notice.
 *
 * Symlinks are a HARD failure rather than being followed or recorded: a bundle
 * is package data we built, a link inside it is not something we ship, and
 * following one would let a link planted in the runtime root read or execute
 * outside it.
 */
export async function computeTreeDigest(root: string): Promise<string> {
  return (await digestTreeWithSnapshot(root)).digest;
}

/**
 * One entry of a tree's stat snapshot: everything a cheap re-check can compare
 * without reading a byte of content.
 *
 * Size and mtime alone are forgeable by anything that can write the file, so
 * two harder fields carry the check: `ino`, which a replacement lands on a new
 * value of unless it was written in place, and `ctimeMs`, which a write in
 * place cannot avoid moving and no syscall can set back. Together they are what
 * makes skipping the full digest on an unchanged tree defensible — the digest
 * itself remains the authority whenever anything here disagrees.
 */
export interface RuntimeTreeEntrySnapshot {
  /** Path relative to the tree root, POSIX separators. */
  path: string;
  size: number;
  mtimeMs: number;
  /**
   * Inode CHANGE time — the field that makes the stat compare detect a
   * rewrite rather than merely notice a careless one.
   *
   * `mtime` is forgeable: `utimes` sets it to anything. `ctime` is not, because
   * no syscall sets it — the kernel stamps it on every metadata change, and
   * `utimes` itself bumps it. So a tamper that opens a file, rewrites its
   * bytes, and restores size, mtime and mode still leaves a ctime strictly
   * later than the one recorded here.
   *
   * Not a substitute for the digest, which remains the authority; it is what
   * makes skipping the digest on an unchanged tree defensible.
   */
  ctimeMs: number;
  ino: number;
  mode: number;
}

export interface RuntimeTreeSnapshot {
  root: string;
  digest: string;
  entries: readonly RuntimeTreeEntrySnapshot[];
  /**
   * Content digests of the files that actually execute, captured during the
   * full digest walk, keyed by relative path.
   *
   * Captured HERE rather than on first re-verify on purpose: a baseline taken
   * later would be taken from whatever the file contains at that point, so the
   * very first re-verify could not detect a rewrite that had already happened.
   * These come from the same read the tree digest hashed, so they describe the
   * bytes the digest admitted.
   */
  executableDigests: Readonly<Record<string, string>>;
}

/**
 * Walk the tree once, producing both the digest and the stat snapshot.
 *
 * The snapshot is a by-product of a walk that already stats every file, so it
 * costs nothing beyond the array. That is the whole point of D8: the expensive
 * part is reading 515 MB of content, and it now happens once per process per
 * pack instead of five times per session start.
 */
async function digestTreeWithSnapshot(
  root: string,
): Promise<RuntimeTreeSnapshot> {
  const hash = createHash("sha256");
  const entriesSnapshot: RuntimeTreeEntrySnapshot[] = [];
  const executableDigests: Record<string, string> = {};
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
      if (++files > MAX_BUNDLE_FILES) {
        throw new Error(
          "managed runtime bundle exceeds the file-count ceiling",
        );
      }
      const info = await stat(full);
      bytes += info.size;
      if (bytes > MAX_BUNDLE_BYTES) {
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
      if (isBaselineHashed(rel)) {
        executableDigests[rel] = contentDigest.toString("hex");
      }
    }
  };

  await walk(root);
  return {
    root,
    digest: `sha256:${hash.digest("hex")}`,
    entries: entriesSnapshot,
    executableDigests,
  };
}

/**
 * Files whose content digest is baselined during the full walk, split by what
 * the pre-spawn re-verify reads again.
 *
 * The stat compare is the primary check and it is strong: it covers path, size,
 * mode, inode and `ctime`, and `ctime` is the one field a tamper cannot put
 * back — the kernel stamps it on every write and no syscall sets it. An
 * in-place rewrite is therefore caught for all ~5,400 files without reading a
 * byte.
 *
 * Re-hashing on top of that is defence for the case where the stat fields
 * cannot be trusted at all: a doctored filesystem image, a restore that rebuilt
 * the metadata, root on the same machine. That is worth a couple of
 * milliseconds and not worth two seconds, and the split is a budget question
 * measured against a real 494 MB pack:
 *
 *   stat walk over 5,462 files   350 ms
 *   launcher.mjs + bridge.mjs      2 ms
 *   bin/node                     334 ms
 *   the vendor `claude` binary  1263 ms
 *                               ───────
 *                               1949 ms  against a 1.5 s session-start SLO
 *
 * So the two small scripts are re-hashed on every spawn — they are the bytes
 * this repo wrote to constrain the bridge, and they are free. The two large
 * binaries join them under `MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY=true`.
 *
 * The vendor CLI is matched by pattern because its name is platform-suffixed
 * inside the vendor's own platform package.
 */
const ALWAYS_REHASHED_RELATIVE_PATHS: readonly string[] = [
  "launcher.mjs",
  "bridge.mjs",
];
const STRICT_REHASHED_PATH_PATTERNS: readonly RegExp[] = [
  /^bin\/node(\.exe)?$/,
  /(^|\/)claude-agent-sdk-[a-z0-9-]+\/(claude|claude\.exe)$/,
  /(^|\/)claude-code-[a-z0-9-]+\/(claude|claude\.exe)$/,
];

/**
 * Read on every call rather than once at module load, so a test — and an
 * operator debugging a machine — can turn it on without a restart. Explicit
 * `"true"`: an unset or misspelled value is off, which is the cheap mode.
 */
function strictReverifyEnabled(): boolean {
  return process.env.MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY === "true";
}

/**
 * Whether the full walk should record a content digest for this path.
 *
 * The union of both sets, ALWAYS — never conditioned on the knob. A baseline
 * captured only in strict mode would mean turning the knob on later had nothing
 * to compare against, and the first strict re-verify would have to either
 * refuse a healthy tree or silently skip the file it was turned on for.
 */
function isBaselineHashed(relativePath: string): boolean {
  return (
    ALWAYS_REHASHED_RELATIVE_PATHS.includes(relativePath) ||
    STRICT_REHASHED_PATH_PATTERNS.some((pattern) => pattern.test(relativePath))
  );
}

/** Whether a pre-spawn re-verify should re-read this path's bytes. */
function isRehashedOnRevalidate(relativePath: string): boolean {
  if (ALWAYS_REHASHED_RELATIVE_PATHS.includes(relativePath)) return true;
  return (
    strictReverifyEnabled() &&
    STRICT_REHASHED_PATH_PATTERNS.some((pattern) => pattern.test(relativePath))
  );
}

/**
 * Process-local verification cache, keyed by canonical root AND the digest the
 * manifest expects.
 *
 * Keying on both matters: a cache keyed on the path alone would answer for a
 * root whose expected digest changed under it (a pack upgrade activating a new
 * version into the same path), which is precisely the case that must re-verify.
 * Entries are never invalidated by time — a stale entry cannot approve a
 * changed tree, because `revalidateRuntime` still stats every file and
 * re-hashes the executable ones before a spawn.
 */
const verifiedRuntimeCache = new Map<string, RuntimeTreeSnapshot>();

function verificationCacheKey(root: string, expectedDigest: string): string {
  return `${root}\u0000${expectedDigest}`;
}

/** Test seam and pack-activation hook: drop everything the cache remembers. */
export function clearRuntimeVerificationCache(): void {
  verifiedRuntimeCache.clear();
}

export type RuntimeVerification =
  | { ok: true; digest: string; snapshot: RuntimeTreeSnapshot; cached: boolean }
  | { ok: false; reason: "digest-mismatch"; digest: string }
  | { ok: false; reason: "unreadable"; message: string };

/**
 * Verify a runtime tree against the digest the manifest names, at most once per
 * process per (root, digest) pair.
 *
 * The full digest is what proves the tree is the artifact CI built. Doing it
 * five times per session start — which is what the foundation did between
 * consent, availability and pre-spawn — cost 3–7 s of a 1.5 s budget for no
 * additional guarantee, because nothing between those calls could have written
 * to a root the session does not own.
 */
export async function verifyRuntime(
  root: string,
  expectedDigest: string,
): Promise<RuntimeVerification> {
  const key = verificationCacheKey(root, expectedDigest);
  const cached = verifiedRuntimeCache.get(key);
  if (cached !== undefined) {
    return { ok: true, digest: cached.digest, snapshot: cached, cached: true };
  }
  let snapshot: RuntimeTreeSnapshot;
  try {
    snapshot = await digestTreeWithSnapshot(root);
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (snapshot.digest !== expectedDigest) {
    return { ok: false, reason: "digest-mismatch", digest: snapshot.digest };
  }
  verifiedRuntimeCache.set(key, snapshot);
  return { ok: true, digest: snapshot.digest, snapshot, cached: false };
}

function runtimeIdOf(parts: readonly string[]): string {
  return `rt_${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Verify a managed runtime bundle and freeze its identity.
 *
 * Called before consent AND again immediately before spawn — a bundle that
 * changed between the two is a different runtime, and re-digesting is cheap
 * compared with launching something the user never agreed to.
 */
export async function resolveManagedBundle(args: {
  manifest: LocalHarnessCompatibility;
  /** Root directory holding per-harness bundles, owned by the install. */
  runtimeRoot: string;
  platform: LocalPlatform;
  /**
   * Defaults to this machine's. Present because the digest that admits a
   * bundle is per OS AND architecture: `bin/node` and the vendor CLI are
   * machine code, so a darwin-x64 host must not be admitted by the
   * darwin-arm64 digest.
   */
  arch?: string;
}): Promise<RuntimeResolution> {
  const { manifest, runtimeRoot, platform } = args;
  if (manifest.runtime.source !== "managed-bundle") {
    return {
      ok: false,
      status: "bundle-absent",
      message: `${manifest.harnessId} is not configured for a managed bundle`,
    };
  }
  const policy = manifest.runtime;
  const root = join(runtimeRoot, policy.bundleName);

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
    const info = await stat(canonicalRoot);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ok: false,
      status: "bundle-absent",
      message:
        `the ${manifest.harnessId} runtime bundle is not present at ${root}. ` +
        `It ships with the Inspector install; reinstall or run the setup step ` +
        `that downloads it. Nothing is installed while a session starts.`,
    };
  }

  const target = localPackTarget(platform, args.arch ?? process.arch);
  const expectedDigest =
    target === null ? undefined : policy.bundleDigest[target];
  if (expectedDigest === undefined) {
    return {
      ok: false,
      status: "bundle-absent",
      message:
        `no ${manifest.harnessId} runtime pack has been built for ` +
        `${platform}, so there is no digest to verify one against`,
    };
  }

  const verification = await verifyRuntime(canonicalRoot, expectedDigest);
  if (!verification.ok && verification.reason === "unreadable") {
    return {
      ok: false,
      status: "bundle-corrupt",
      message:
        `the ${manifest.harnessId} runtime bundle could not be digested: ` +
        `${verification.message}`,
    };
  }
  if (!verification.ok) {
    return {
      ok: false,
      status: "bundle-digest-mismatch",
      message:
        `the ${manifest.harnessId} runtime bundle does not match the digest ` +
        `this Inspector was built with. Expected ${expectedDigest}, ` +
        `found ${verification.digest}. The bundle is not user- or ` +
        `session-writable by design, so a mismatch means it was replaced — ` +
        `local execution stays disabled until it is reinstalled.`,
    };
  }
  const digest = verification.digest;

  // The digest covers the TREE; both the launcher and the Node binary that
  // interprets it must be files inside it. A `..` in either manifest-relative
  // path would otherwise resolve outside the bytes consent verified, and the
  // supervisor would launch that.
  const insideBundle = async (
    relativePath: string,
    label: string,
    requireExecutable: boolean,
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }> => {
    const full = join(canonicalRoot, relativePath);
    if (!normalize(full).startsWith(canonicalRoot + sep)) {
      return {
        ok: false,
        message:
          `the ${manifest.harnessId} manifest points its ${label} outside ` +
          `the bundle whose digest was verified`,
      };
    }
    try {
      const info = await stat(full);
      if (!info.isFile()) throw new Error("not a file");
      if (requireExecutable && (info.mode & 0o111) === 0) {
        throw new Error("not executable");
      }
    } catch {
      return {
        ok: false,
        message:
          `the ${manifest.harnessId} runtime bundle has no usable ${label} ` +
          `at ${relativePath}`,
      };
    }
    return { ok: true, path: full };
  };

  const launcher = await insideBundle(
    policy.launcherRelativePath,
    "launcher",
    false,
  );
  if (!launcher.ok) {
    return { ok: false, status: "bundle-corrupt", message: launcher.message };
  }
  const launcherPath = launcher.path;

  // The pack's own Node. Both distributions use it — Electron's `RunAsNode`
  // fuse is off, and the npx server's own `process.execPath` is outside the
  // tree the digest covers — so a pack without one cannot launch a bridge.
  const bundledNode = await insideBundle(
    policy.nodeLauncherRelativePath,
    "Node binary",
    true,
  );
  if (!bundledNode.ok) {
    return { ok: false, status: "bundle-corrupt", message: bundledNode.message };
  }

  // Windows: the Job Object launcher, which is what makes whole-tree cleanup
  // possible there at all. Resolved from INSIDE the verified tree — a helper
  // sitting next to the pack proves nothing, and one this process has not
  // digest-verified is a binary we would be spawning on a promise.
  //
  // Its absence is not an error: the platform simply stays ineligible, which is
  // what `supportsOwnershipProof('win32')` already reports and what the
  // manifest's `nativePlatforms` already says.
  let jobLauncherPath: string | undefined;
  if (platform === "win32" && policy.jobLauncherRelativePath) {
    const helper = await insideBundle(
      policy.jobLauncherRelativePath,
      "job launcher",
      true,
    );
    if (helper.ok) jobLauncherPath = helper.path;
  }
  setWindowsJobLauncherVerified(jobLauncherPath !== undefined);

  return {
    ok: true,
    runtime: {
      runtimeId: runtimeIdOf([
        "managed-bundle",
        manifest.harnessId,
        manifest.adapterVersion,
        platform,
        digest,
      ]),
      source: "managed-bundle",
      harnessId: manifest.harnessId,
      platform,
      adapterVersion: manifest.adapterVersion,
      rootPath: canonicalRoot,
      launcherPath,
      nodePath: bundledNode.path,
      ...(jobLauncherPath !== undefined ? { jobLauncherPath } : {}),
      digest,
      vendorPackages: policy.vendorPackages,
    },
  };
}

/**
 * Directories a system executable may legitimately live in, per platform.
 *
 * Deliberately short and system-owned. A vendor CLI installed under the user's
 * home through a version manager is not rejected because it is untrustworthy —
 * it is rejected because THAT path is writable by everything the user runs,
 * including the agent we are about to start, so "the file we probed" and "the
 * file that launches" would be two different claims.
 */
export function systemInstallSearchPaths(platform: LocalPlatform): string[] {
  switch (platform) {
    case "darwin":
      return ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
    case "linux":
      return ["/usr/local/bin", "/usr/bin", "/bin"];
    case "win32":
      return ["C:\\Program Files", "C:\\Program Files (x86)"];
  }
}

/** Paths a discovered executable must NOT resolve into. */
function isUntrustedInstallPath(
  canonical: string,
  forbiddenRoots: readonly string[],
): string | null {
  for (const root of forbiddenRoots) {
    if (canonical === root || canonical.startsWith(root + sep)) {
      return root;
    }
  }
  if (/(^|[\\/])node_modules([\\/]|$)/.test(canonical)) {
    return "a node_modules directory";
  }
  return null;
}

/**
 * The version a probe line reports, INCLUDING any prerelease qualifier.
 *
 * Capturing only `x.y.z` would silently read `2.0.0-beta.1` as `2.0.0` and let
 * a prerelease satisfy a stable minimum. The qualifier is kept so the range
 * check below can refuse it explicitly.
 */
function extractVersion(line: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line)?.[1] ?? null;
}

/**
 * Range check for the ONLY grammar a manifest may write: `>=x.y.z`.
 *
 * Deliberately not a semver dependency, and deliberately not a partial
 * implementation of one: the manifest is Inspector-owned, so the supported
 * grammar is a closed set, and every range outside it — every prerelease
 * version — is refused rather than approximated. `isSupportedVersionRange`
 * exists so the manifest itself can be validated against the same grammar
 * instead of failing only at discovery time.
 */
export function isSupportedVersionRange(range: string): boolean {
  return /^>=\s*\d+\.\d+\.\d+$/.test(range.trim());
}

function satisfiesMinimumRange(version: string, range: string): boolean {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) return false;
  // A prerelease is not a released version; accepting one against a stable
  // minimum would run a build the manifest never approved.
  if (version.includes("-")) return false;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
    return false;
  const min = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i += 1) {
    if (parts[i]! > min[i]!) return true;
    if (parts[i]! < min[i]!) return false;
  }
  return true;
}

export interface SystemDiscoveryOptions {
  manifest: LocalHarnessCompatibility;
  platform: LocalPlatform;
  /** Roots a runtime may never resolve into: the selected workspace, the
   *  session state dir, and anything else the session can write. */
  forbiddenRoots: readonly string[];
  /** Override for tests; defaults to `systemInstallSearchPaths`. */
  searchPaths?: readonly string[];
  /** Override for tests; runs the identity probe. */
  probe?: (
    executable: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; exitCode: number }>;
}

async function defaultProbe(
  executable: string,
  args: readonly string[],
): Promise<{ stdout: string; exitCode: number }> {
  return await new Promise((resolvePromise) => {
    // `execFile`, never `exec`: no shell, argv passed structurally, bounded
    // output and a short timeout. The probe learns identity; it is not a
    // capability the vendor process inherits.
    execFile(
      executable,
      [...args],
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
        env: { PATH: "", LANG: "C" },
      },
      (error, stdout) => {
        resolvePromise({
          stdout: typeof stdout === "string" ? stdout : "",
          exitCode: error ? 1 : 0,
        });
      },
    );
  });
}

/**
 * Discover, canonicalize, and identity-probe a system installation.
 *
 * Returns the FIRST acceptable candidate but reports ambiguity: two acceptable
 * installations mean we cannot say which one the user meant, and guessing is
 * how consent ends up bound to a different binary than the one that runs.
 */
/**
 * The first ancestor directory of `path` that a non-system owner could write,
 * or `null` when every one of them is system-owned and not group- or
 * world-writable.
 *
 * Checking the executable alone is not enough: `unlink` and `rename` are
 * authorized by the containing DIRECTORY's permissions, so a root-owned,
 * mode-0755 binary sitting in a user-writable directory can be moved aside and
 * replaced entirely. The file's uid and mode are unchanged by that — a new
 * file simply takes its name.
 *
 * The sticky bit is the one exemption, and it is not a loophole: on a sticky
 * directory only a file's owner may unlink or rename it, which is exactly the
 * property being checked. `/tmp` is mode 1777 for this reason, and without the
 * exemption every installation below it would be refused for a risk the sticky
 * bit already removes.
 *
 * ── Mode bits are not blind to POSIX ACLs ────────────────────────────────
 * The group bits carry the ACL MASK once a directory has a POSIX ACL, so an
 * entry granting another user write makes this check fire. Verified rather
 * than assumed: on a 0755 directory, adding `u:65534:rwx` (mask `rwx`) moves
 * `st_mode` to 0775. That is why the group-writable test below covers more
 * than plain group permissions, and why removing it would quietly widen this.
 *
 * It does NOT extend to macOS's NFSv4-style ACLs, which grant rights such as
 * `delete_child` without appearing in `st_mode` at all and which Node cannot
 * read. `system-install` is therefore refused outright on darwin — see
 * `resolveSystemInstall` — rather than checked with a test known to be blind
 * there.
 *
 * A directory that cannot be `stat`ed is treated as untrusted: this answers a
 * security question, and "could not look" is not "safe".
 */
async function firstUntrustedAncestor(
  path: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  // Windows has no uid and its ACLs are not readable through `fs.Stats`;
  // system-install is not offered there, and pretending to check would be
  // worse than not claiming it.
  if (platform === "win32") return null;
  let dir = dirname(path);
  for (;;) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(dir);
    } catch {
      return dir;
    }
    const looselyWritable =
      (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0;
    if (info.uid !== 0 || looselyWritable) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function resolveSystemInstall(
  opts: SystemDiscoveryOptions,
): Promise<RuntimeResolution> {
  const { manifest, platform } = opts;
  if (manifest.runtime.source !== "system-install") {
    return {
      ok: false,
      status: "system-runtime-not-installed",
      message: `${manifest.harnessId} is not configured for a system install`,
    };
  }
  // Darwin's ACLs grant rights like `delete_child` without touching
  // `st_mode`, and Node exposes no way to read them — so the ancestor-trust
  // check below is KNOWN to be blind there, and a discovery that cannot make
  // its own guarantee must refuse rather than report a trust it did not
  // establish. (Linux is fine: a POSIX ACL's mask lands in the group bits, so
  // the same check does see those.) This is an unsupported tuple, failing
  // closed with a diagnostic, not a silent gap.
  if (platform === "darwin") {
    return {
      ok: false,
      status: "system-runtime-untrusted-path",
      message:
        `a system installation cannot be trusted on macOS by this Inspector: ` +
        `directory ACLs there can grant replacement rights without appearing ` +
        `in the file mode, and nothing here can read them. Use a managed ` +
        `bundle, whose digest is verified in full.`,
    };
  }
  const policy = manifest.runtime;
  const searchPaths = opts.searchPaths ?? systemInstallSearchPaths(platform);
  const probe = opts.probe ?? defaultProbe;

  const accepted: ResolvedRuntime[] = [];
  // Rejections carry the status they should REPORT: telling a user their
  // vendor CLI lives somewhere the session can write, when in fact its
  // `--version` probe failed, sends them to fix the wrong thing.
  const rejections: Array<{
    status: RuntimeResolutionFailure["status"];
    message: string;
  }> = [];

  for (const dir of searchPaths) {
    for (const name of policy.executableNames) {
      const candidate = join(dir, name);
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        continue;
      }
      if (!isAbsolute(canonical)) continue;

      const untrusted = isUntrustedInstallPath(canonical, opts.forbiddenRoots);
      if (untrusted) {
        rejections.push({
          status: "system-runtime-untrusted-path",
          message:
            `${candidate} resolves into ${untrusted}, which the session or ` +
            `the workspace can write`,
        });
        continue;
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(canonical);
      } catch {
        continue;
      }
      if (!info.isFile() || (info.mode & 0o111) === 0) {
        rejections.push({
          status: "system-runtime-not-installed",
          message: `${candidate} is not an executable file`,
        });
        continue;
      }
      // Group- or world-writable means anything on the machine can swap it
      // between the probe and the launch.
      if ((info.mode & 0o022) !== 0) {
        rejections.push({
          status: "system-runtime-untrusted-path",
          message:
            `${candidate} is group- or world-writable, so its identity ` +
            `cannot be held between verification and launch`,
        });
        continue;
      }
      // Ownership, not just mode: a file owned by the session user can be
      // rewritten by the very agent we are about to start, between this check
      // and the launch. Mode 0755 does not help — the owner can chmod it. So a
      // system installation must belong to a system owner.
      //
      // This is strict on purpose, and it is why no shipped manifest selects
      // `system-install` yet: the common macOS case (a Homebrew prefix owned by
      // the user) cannot satisfy it, and the honest answer there is the
      // platform provenance verifier above, not a relaxed ownership rule.
      if (platform !== "win32" && info.uid !== 0) {
        rejections.push({
          status: "system-runtime-untrusted-path",
          message:
            `${candidate} is owned by uid ${info.uid} rather than a system ` +
            `owner, so the supervised agent — which runs as that user — could ` +
            `replace it between verification and launch`,
        });
        continue;
      }

      // A trusted file under an untrusted directory is not trusted. Unlink
      // and rename are governed by the DIRECTORY's permissions, not the
      // file's, so a root-owned binary in a user-writable directory can be
      // moved aside and replaced wholesale by the very agent we are about to
      // start — the file's own uid and mode say nothing about that.
      const untrustedAncestor = await firstUntrustedAncestor(
        canonical,
        platform,
      );
      if (untrustedAncestor !== null) {
        rejections.push({
          status: "system-runtime-untrusted-path",
          message:
            `${candidate} lives under ${untrustedAncestor}, which is ` +
            `writable by a non-system owner. Replacing the executable there ` +
            `needs only directory permissions, so its verified identity ` +
            `cannot be held between verification and launch`,
        });
        continue;
      }

      // [7] `requirePlatformProvenance` is a promise the manifest makes. There
      // is no code-signature verifier here yet, so honouring it means failing
      // CLOSED rather than quietly accepting an executable on the strength of
      // its own `--version` output.
      if (policy.vendorIdentityPolicy.requirePlatformProvenance) {
        rejections.push({
          status: "system-runtime-identity-mismatch",
          message:
            `${manifest.harnessId} requires platform code-signing/package ` +
            `provenance, and this Inspector has no verifier for ${platform} ` +
            `yet, so the candidate at ${candidate} cannot be accepted`,
        });
        continue;
      }

      const result = await probe(
        canonical,
        policy.vendorIdentityPolicy.probeArgs,
      );
      const line = result.stdout.trim().split("\n")[0] ?? "";
      if (
        result.exitCode !== 0 ||
        !new RegExp(policy.vendorIdentityPolicy.stdoutPattern).test(line)
      ) {
        rejections.push({
          status: "system-runtime-identity-mismatch",
          message:
            `${candidate} did not identify itself as ${manifest.harnessId} ` +
            `(probe output ${JSON.stringify(line.slice(0, 120))})`,
        });
        continue;
      }

      // [15] The manifest declares a version range; accepting anything whose
      // first line merely matches the identity pattern would ignore it.
      if (!isSupportedVersionRange(policy.executableVersionRange)) {
        rejections.push({
          status: "system-runtime-identity-mismatch",
          message:
            `the ${manifest.harnessId} manifest declares version range ` +
            `${JSON.stringify(policy.executableVersionRange)}, which is not ` +
            `one of the shapes this Inspector evaluates (">=x.y.z")`,
        });
        continue;
      }
      const version = extractVersion(line);
      if (
        version === null ||
        !satisfiesMinimumRange(version, policy.executableVersionRange)
      ) {
        rejections.push({
          status: "system-runtime-identity-mismatch",
          message:
            `${candidate} reports version ${
              version ?? "(unparseable)"
            }, which ` +
            `is outside the manifest range ${policy.executableVersionRange}`,
        });
        continue;
      }

      const content = await readFile(canonical);
      const digest = `sha256:${createHash("sha256")
        .update(content)
        .digest("hex")}`;
      accepted.push({
        runtimeId: runtimeIdOf([
          "system-install",
          manifest.harnessId,
          manifest.adapterVersion,
          platform,
          canonical,
          digest,
          String(info.ino),
        ]),
        source: "system-install",
        harnessId: manifest.harnessId,
        platform,
        adapterVersion: manifest.adapterVersion,
        rootPath: canonical,
        launcherPath: canonical,
        digest,
        vendorPackages: {},
        vendorVersionLine: line,
      });
    }
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      // Report the FIRST real rejection's own status, not a blanket one.
      status: rejections[0]?.status ?? "system-runtime-not-installed",
      message:
        `no acceptable ${manifest.harnessId} installation was found in ` +
        `${searchPaths.join(", ")}.` +
        (rejections.length
          ? ` Rejected: ${rejections.map((r) => r.message).join("; ")}.`
          : "") +
        ` Inspector never installs or upgrades a harness during a session.`,
    };
  }
  if (accepted.length > 1) {
    const distinct = new Set(accepted.map((r) => r.rootPath));
    if (distinct.size > 1) {
      return {
        ok: false,
        status: "system-runtime-ambiguous",
        message:
          `more than one ${manifest.harnessId} installation is acceptable ` +
          `(${[...distinct].join(
            ", ",
          )}). Remove or disambiguate them: consent ` +
          `must name exactly one runtime.`,
      };
    }
  }

  return { ok: true, runtime: accepted[0]! };
}

/**
 * Compare a tree against the snapshot taken during its full digest.
 *
 * Returns a short human-readable reason on the FIRST difference, or `null` if
 * the tree still matches. The reason names the relative path only — never an
 * absolute one — because it travels into a user-facing refusal message.
 *
 * Two halves, both required:
 *
 *  - every recorded file must still be there with the same size, mtime, inode
 *    and mode, and no extra file may have appeared (checked by counting the
 *    walk, which is why the walk runs even though the snapshot has the list);
 *  - the scripts that constrain the bridge are re-hashed outright, because an
 *    in-place rewrite that restored size, mtime, inode and mode is exactly the
 *    attack a stat compare is weakest against, and they cost 2 ms. The two
 *    large binaries join them under `MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY`;
 *    see the split above for what that costs.
 */
async function detectSnapshotDrift(
  snapshot: RuntimeTreeSnapshot,
): Promise<string | null> {
  const recorded = new Map(snapshot.entries.map((e) => [e.path, e]));
  let seen = 0;

  const walk = async (dir: string): Promise<string | null> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(snapshot.root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) return `a symlink appeared at ${rel}`;
      if (entry.isDirectory()) {
        const nested = await walk(full);
        if (nested !== null) return nested;
        continue;
      }
      if (!entry.isFile()) return `a non-regular file appeared at ${rel}`;
      const expected = recorded.get(rel);
      if (expected === undefined) return `an unexpected file appeared at ${rel}`;
      seen += 1;
      const info = await stat(full);
      if (
        info.size !== expected.size ||
        info.mtimeMs !== expected.mtimeMs ||
        info.ctimeMs !== expected.ctimeMs ||
        Number(info.ino) !== expected.ino ||
        info.mode !== expected.mode
      ) {
        return `${rel} was modified`;
      }
      if (isRehashedOnRevalidate(rel)) {
        const content = await readFile(full);
        const fileDigest = createHash("sha256").update(content).digest("hex");
        if (fileDigest !== snapshot.executableDigests[rel]) {
          return `${rel} was rewritten in place`;
        }
      }
    }
    return null;
  };

  const reason = await walk(snapshot.root);
  if (reason !== null) return reason;
  if (seen !== snapshot.entries.length) {
    return `${snapshot.entries.length - seen} file(s) went missing`;
  }
  return null;
}

/**
 * Re-verify a runtime immediately before spawn.
 *
 * Consent was granted against a `runtimeId`; this proves the thing on disk is
 * still that runtime.
 *
 * For a managed bundle the full digest ran once, in `verifyRuntime`, and left
 * a stat snapshot behind. This re-check compares that snapshot entry for entry
 * — a missing file, an added file, a changed size, mtime, inode or mode — and
 * re-hashes the handful of files that actually execute.
 *
 * The snapshot is an OPTIMIZATION, never the authority: anything it flags
 * falls through to the same full digest that admitted the tree in the first
 * place. That matters in both directions. A tampered tree cannot pass, because
 * the digest still has to match. And reinstalling the same pack version — new
 * mtimes and inodes, identical bytes — is admitted rather than refused, which
 * a snapshot treated as authoritative would have got wrong.
 *
 * With no snapshot (a fresh process that resolved its runtime from a cache
 * that has since been cleared) it falls back to the full digest rather than
 * trusting a tree it never measured.
 */
export async function revalidateRuntime(
  runtime: ResolvedRuntime,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (runtime.source === "managed-bundle") {
      const snapshot = verifiedRuntimeCache.get(
        verificationCacheKey(runtime.rootPath, runtime.digest),
      );
      if (snapshot === undefined) {
        const verification = await verifyRuntime(
          runtime.rootPath,
          runtime.digest,
        );
        if (!verification.ok) {
          return {
            ok: false,
            message:
              verification.reason === "digest-mismatch"
                ? `the ${runtime.harnessId} runtime bundle changed after ` +
                  `consent was granted (expected ${runtime.digest}, found ` +
                  `${verification.digest})`
                : `the ${runtime.harnessId} runtime could not be re-verified: ` +
                  `${verification.message}`,
          };
        }
        return { ok: true };
      }
      const drift = await detectSnapshotDrift(snapshot);
      if (drift === null) return { ok: true };

      // Drift is a signal to look properly, not a verdict. Reinstalling the
      // SAME pack version rewrites every file with new mtimes and inodes while
      // the content — and therefore the digest consent named — is unchanged;
      // refusing that would break reinstall for no security gain. So the full
      // digest decides, exactly as it does on first admission, and the cheap
      // check only ever buys skipping it.
      verifiedRuntimeCache.delete(
        verificationCacheKey(runtime.rootPath, runtime.digest),
      );
      const reverified = await verifyRuntime(runtime.rootPath, runtime.digest);
      if (reverified.ok) return { ok: true };
      return {
        ok: false,
        message:
          reverified.reason === "digest-mismatch"
            ? `the ${runtime.harnessId} runtime bundle changed after consent ` +
              `was granted (${drift}; expected ${runtime.digest}, found ` +
              `${reverified.digest})`
            : `the ${runtime.harnessId} runtime could not be re-verified: ` +
              `${reverified.message}`,
      };
    }
    const content = await readFile(runtime.launcherPath);
    const digest = `sha256:${createHash("sha256")
      .update(content)
      .digest("hex")}`;
    if (digest !== runtime.digest) {
      return {
        ok: false,
        message:
          `the ${runtime.harnessId} executable at ${runtime.launcherPath} was ` +
          `replaced after consent was granted`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message:
        `the ${runtime.harnessId} runtime could not be re-verified: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
