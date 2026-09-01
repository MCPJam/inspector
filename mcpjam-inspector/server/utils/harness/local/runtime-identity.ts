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
import { isAbsolute, join, relative, sep } from "node:path";
import type { LocalHarnessCompatibility } from "./compatibility.js";
import type { LocalPlatform, SupportedLocalHarnessId } from "./targets.js";

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
  const hash = createHash("sha256");
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
            `built as plain files so their digest describes exactly what runs`
        );
      }
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `managed runtime bundle contains a non-regular file at ${rel}`
        );
      }
      if (++files > MAX_BUNDLE_FILES) {
        throw new Error("managed runtime bundle exceeds the file-count ceiling");
      }
      const info = await stat(full);
      bytes += info.size;
      if (bytes > MAX_BUNDLE_BYTES) {
        throw new Error("managed runtime bundle exceeds the size ceiling");
      }
      const content = await readFile(full);
      const executable = (info.mode & 0o111) !== 0 ? "1" : "0";
      hash.update(`f\0${rel}\0${executable}\0${info.size}\0`);
      hash.update(createHash("sha256").update(content).digest());
    }
  };

  await walk(root);
  return `sha256:${hash.digest("hex")}`;
}

function runtimeIdOf(parts: readonly string[]): string {
  return `rt_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
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

  let digest: string;
  try {
    digest = await computeTreeDigest(canonicalRoot);
  } catch (error) {
    return {
      ok: false,
      status: "bundle-corrupt",
      message:
        `the ${manifest.harnessId} runtime bundle could not be digested: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (digest !== policy.bundleDigest) {
    return {
      ok: false,
      status: "bundle-digest-mismatch",
      message:
        `the ${manifest.harnessId} runtime bundle does not match the digest ` +
        `this Inspector was built with. Expected ${policy.bundleDigest}, ` +
        `found ${digest}. The bundle is not user- or session-writable by ` +
        `design, so a mismatch means it was replaced — local execution stays ` +
        `disabled until it is reinstalled.`,
    };
  }

  const launcherPath = join(canonicalRoot, policy.launcherRelativePath);
  try {
    const info = await stat(launcherPath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    return {
      ok: false,
      status: "bundle-corrupt",
      message:
        `the ${manifest.harnessId} runtime bundle has no launcher at ` +
        `${policy.launcherRelativePath}`,
    };
  }

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
      return [
        "C:\\Program Files",
        "C:\\Program Files (x86)",
      ];
  }
}

/** Paths a discovered executable must NOT resolve into. */
function isUntrustedInstallPath(
  canonical: string,
  forbiddenRoots: readonly string[]
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
    args: readonly string[]
  ) => Promise<{ stdout: string; exitCode: number }>;
}

async function defaultProbe(
  executable: string,
  args: readonly string[]
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
      }
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
export async function resolveSystemInstall(
  opts: SystemDiscoveryOptions
): Promise<RuntimeResolution> {
  const { manifest, platform } = opts;
  if (manifest.runtime.source !== "system-install") {
    return {
      ok: false,
      status: "system-runtime-not-installed",
      message: `${manifest.harnessId} is not configured for a system install`,
    };
  }
  const policy = manifest.runtime;
  const searchPaths = opts.searchPaths ?? systemInstallSearchPaths(platform);
  const probe = opts.probe ?? defaultProbe;

  const accepted: ResolvedRuntime[] = [];
  const rejections: string[] = [];

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
        rejections.push(
          `${candidate} resolves into ${untrusted}, which the session or the ` +
            `workspace can write`
        );
        continue;
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(canonical);
      } catch {
        continue;
      }
      if (!info.isFile() || (info.mode & 0o111) === 0) {
        rejections.push(`${candidate} is not an executable file`);
        continue;
      }
      // Group- or world-writable means anything on the machine can swap it
      // between the probe and the launch.
      if ((info.mode & 0o022) !== 0) {
        rejections.push(
          `${candidate} is group- or world-writable, so its identity cannot be ` +
            `held between verification and launch`
        );
        continue;
      }

      const result = await probe(canonical, policy.vendorIdentityPolicy.probeArgs);
      const line = result.stdout.trim().split("\n")[0] ?? "";
      if (
        result.exitCode !== 0 ||
        !new RegExp(policy.vendorIdentityPolicy.stdoutPattern).test(line)
      ) {
        rejections.push(
          `${candidate} did not identify itself as ${manifest.harnessId} ` +
            `(probe output ${JSON.stringify(line.slice(0, 120))})`
        );
        continue;
      }

      const content = await readFile(canonical);
      const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
      status: rejections.length
        ? "system-runtime-untrusted-path"
        : "system-runtime-not-installed",
      message:
        `no acceptable ${manifest.harnessId} installation was found in ` +
        `${searchPaths.join(", ")}.` +
        (rejections.length ? ` Rejected: ${rejections.join("; ")}.` : "") +
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
          `(${[...distinct].join(", ")}). Remove or disambiguate them: consent ` +
          `must name exactly one runtime.`,
      };
    }
  }

  return { ok: true, runtime: accepted[0]! };
}

/**
 * Re-verify a runtime immediately before spawn.
 *
 * Consent was granted against a `runtimeId`; this proves the thing on disk
 * still hashes to it. A managed bundle is fully re-digested. A system
 * executable is re-read and re-hashed — cheap, and the only way to notice a
 * replacement that happened after the user clicked Allow.
 */
export async function revalidateRuntime(
  runtime: ResolvedRuntime
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (runtime.source === "managed-bundle") {
      const digest = await computeTreeDigest(runtime.rootPath);
      if (digest !== runtime.digest) {
        return {
          ok: false,
          message:
            `the ${runtime.harnessId} runtime bundle changed after consent was ` +
            `granted (expected ${runtime.digest}, found ${digest})`,
        };
      }
      return { ok: true };
    }
    const content = await readFile(runtime.launcherPath);
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
