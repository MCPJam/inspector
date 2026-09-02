/**
 * Installing the runtime pack — the one place a 515 MB third-party tree gets
 * onto the user's machine, and the one place it is proven to be ours.
 *
 * ── Why this is a separate, explicit step ────────────────────────────────
 * The pack cannot ship inside the npm package or the DMG (size, and coupling
 * notarization to a vendor binary), so it is downloaded. Downloading is
 * therefore a thing the user asks for and watches, not something a session
 * start does behind their back: `installRuntimePack` is called from the
 * consent flow's "Install local runtime" button or the `harness install`
 * subcommand, and NEVER from a turn. A session that finds no pack refuses with
 * `bundle-absent` and says so.
 *
 * ── The verification chain ───────────────────────────────────────────────
 * Three checks, in this order, each covering the next:
 *
 *   1. the manifest's Ed25519 signature — proves MCPJam published it;
 *   2. the archive's sha256 against the manifest — proves the bytes that
 *      arrived are the bytes the manifest describes;
 *   3. the extracted tree's canonical digest against the manifest — proves
 *      extraction produced what was archived, and is the same digest the
 *      session-start path re-verifies against later.
 *
 * Doing (3) as well as (2) is not redundant: extraction is where a path
 * traversal, a symlink, or a truncated write would land, and the tree digest
 * is what every later check compares against.
 *
 * ── Atomicity ────────────────────────────────────────────────────────────
 * Extraction goes into a sibling `.mcpjam-tmp-*` directory and is renamed into
 * place only after all three checks pass. A crashed or failed install leaves a
 * temp directory to sweep, never a half-written version directory that
 * `resolveManagedBundle` would then try to digest.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { x as extractTar } from "tar";
import { logger } from "../../logger.js";
import {
  EXPECTED_PACK_VERSION,
  PACK_RECORDS,
} from "./pack-digests.generated.js";
import { verifyPackManifestSignature } from "./pack-signing-key.js";
import {
  clearRuntimeVerificationCache,
  computeTreeDigest,
} from "./runtime-identity.js";
import {
  currentLocalPlatform,
  localPackTarget,
  type LocalPackTarget,
  type LocalPlatform,
  type SupportedLocalHarnessId,
} from "./targets.js";

/** Ceiling on a downloaded archive. A pack compresses to roughly 150-200 MB;
 *  anything past this is not an artifact we published. */
const MAX_ARCHIVE_BYTES = 1_500 * 1024 * 1024;
/** Ceiling on the extracted tree, matching the digest walk's own limit. */
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Where packs live.
 *
 * Electron sets `MCPJAM_RUNTIME_ROOT` from `app.getPath("userData")` so a
 * packaged app keeps its runtime with the rest of its own state; npx falls
 * back to the same `~/.mcpjam` tree the grants and machine identity already
 * use. Both are per-user and outside any workspace, which is what keeps the
 * pack out of reach of the agent it launches.
 */
export function runtimeInstallRoot(): string {
  const override = process.env.MCPJAM_RUNTIME_ROOT;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".mcpjam", "harness-local", "runtime");
}

/**
 * The directory a pack activates into, and the `runtimeRoot` the availability
 * gate is then given.
 *
 * Keyed by TARGET as well as version. On an Apple Silicon Mac an arm64
 * Inspector and a Rosetta x64 one share a home directory and would otherwise
 * activate two different artifacts — same version, different machine code — at
 * the same path: installing either would delete the other's runtime out from
 * under any session using it. A target segment makes them neighbours instead,
 * and gives the version sweep a scope that cannot reach across architectures.
 */
export function packVersionRoot(
  packVersion: string,
  target: LocalPackTarget | null = localPackTarget(),
): string {
  return join(targetInstallRoot(target), packVersion);
}

/** Where every version for one target lives. */
function targetInstallRoot(target: LocalPackTarget | null): string {
  return join(runtimeInstallRoot(), target ?? packPlatformKey());
}

export type RuntimeInstallStatus =
  | { state: "unsupported-platform"; message: string }
  | { state: "absent"; packVersion: string }
  | { state: "downloading"; packVersion: string; percent: number }
  | { state: "verifying"; packVersion: string }
  | { state: "ready"; packVersion: string; runtimeRoot: string; digest: string }
  | { state: "corrupt"; packVersion: string; message: string };

export interface PackManifest {
  schema: string;
  harnessId: string;
  packVersion: string;
  adapterVersion: string;
  platform: string;
  nodeVersion: string;
  treeDigest: string;
  files: number;
  bytes: number;
  archive?: { name: string; sha256: string };
}

/**
 * Which pack this Inspector build expects, for a platform.
 *
 * `null` means no pack was built for this platform, which is a refusal the UI
 * shows rather than an error — it is the honest state for, say, Windows before
 * the Job Object work lands.
 */
export function expectedPackFor(
  harnessId: SupportedLocalHarnessId,
  /**
   * The OS **and** architecture, because that is what a pack is built for. A
   * lookup by OS alone would hand a darwin-x64 machine the darwin-arm64 digest.
   */
  target: LocalPackTarget,
): { packVersion: string; treeDigest: string } | null {
  const override = developmentPackExpectation();
  if (override !== null) return override;
  const record = PACK_RECORDS[harnessId]?.[target];
  if (record === undefined) return null;
  return { packVersion: record.packVersion, treeDigest: record.treeDigest };
}

/**
 * A build- and development-time expectation, from
 * `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK=<version>:sha256:<hex>`.
 *
 * The pack build has to be able to prove the INSTALLER accepts what it just
 * produced, and at that moment the generated digest table cannot possibly name
 * the digest — the build is what produces it. Without this the verification
 * step could only ever run against a pack from a previous release, which is not
 * the artifact about to be published.
 *
 * Honoured ONLY when `MCPJAM_LOCAL_HARNESS_PACK_SOURCE` is also set. That is
 * what keeps it from being a way to widen what a shipped Inspector will
 * install: on its own it names a digest but no source, so the installer still
 * only fetches the release asset and still only accepts the digest this build
 * carries. Both together mean somebody is deliberately installing a local pack
 * they built, which is the case this exists for.
 */
function developmentPackExpectation(): {
  packVersion: string;
  treeDigest: string;
} | null {
  const source = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  const expected = process.env.MCPJAM_LOCAL_HARNESS_EXPECTED_PACK;
  if (!source || !expected) return null;
  const separator = expected.indexOf(":");
  if (separator <= 0) return null;
  const packVersion = expected.slice(0, separator).trim();
  const treeDigest = expected.slice(separator + 1).trim();
  if (packVersion.length === 0) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(treeDigest)) return null;
  return { packVersion, treeDigest };
}

/**
 * The release asset a pack is downloaded from.
 *
 * Packs are attached to the GitHub Release the existing `release.yml` already
 * creates, so there is no new hosting, no new credentials, and the artifact is
 * served from the same place as everything else in a release. The override
 * exists for development against a locally built pack, and takes a file path
 * or a URL.
 */
export function packSourceFor(
  packVersion: string,
  platformKey: string,
): { kind: "file" | "url"; location: string } {
  const override = process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  if (override && override.trim().length > 0) {
    const value = override.trim();
    return /^https?:\/\//.test(value)
      ? { kind: "url", location: value }
      : { kind: "file", location: value.replace(/^file:\/\//, "") };
  }
  // Packs are attached to the Inspector release itself, and stamped with the
  // same version, so the tag is `v<version>` — the tag `release.yml` already
  // creates. No separate release, no separate tag to keep in step.
  return {
    kind: "url",
    location:
      `https://github.com/MCPJam/inspector/releases/download/v${packVersion}/` +
      `local-harness-pack-${platformKey}-${packVersion}.tar.gz`,
  };
}

/**
 * Platform key as the pack build names it: `<os>-<arch>`.
 *
 * Deliberately a plain string and not `LocalPackTarget`: this is what goes in
 * a user-facing message about a machine we have NO pack for, so it has to be
 * able to say `linux-riscv64`. `localPackTarget` is the one that answers
 * whether a pack exists.
 */
export function packPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/**
 * Report what is on disk, without touching the network and without a full
 * digest.
 *
 * Deliberately cheap: this runs at startup and on every availability poll, and
 * a status call that digested 515 MB would be a worse version of the problem
 * D8 was about. It answers `ready` from the presence of the activation marker
 * the install wrote after verifying; the session-start path is where the tree
 * is actually re-verified.
 */
export async function readRuntimeInstallStatus(args: {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<RuntimeInstallStatus> {
  const platform = currentLocalPlatform(args.platform ?? process.platform);
  if (platform === null) {
    return {
      state: "unsupported-platform",
      message: `${args.platform ?? process.platform} has no local harness runtime`,
    };
  }
  const target = localPackTarget(args.platform, args.arch);
  const expected =
    target === null ? null : expectedPackFor(args.harnessId, target);
  if (expected === null) {
    return {
      state: "unsupported-platform",
      message:
        `no ${args.harnessId} runtime pack has been built for ` +
        `${packPlatformKey(args.platform, args.arch)}`,
    };
  }
  const inFlight = active.get(expected.packVersion);
  if (inFlight !== undefined) return inFlight.status;

  const root = packVersionRoot(expected.packVersion, target);
  try {
    const marker = JSON.parse(
      await readFile(join(root, INSTALL_MARKER), "utf8"),
    ) as { treeDigest?: string };
    if (marker.treeDigest !== expected.treeDigest) {
      return {
        state: "corrupt",
        packVersion: expected.packVersion,
        message:
          "the installed runtime pack does not match the digest this " +
          "Inspector expects; reinstall it",
      };
    }
    await stat(join(root, args.harnessId));
    return {
      state: "ready",
      packVersion: expected.packVersion,
      runtimeRoot: root,
      digest: expected.treeDigest,
    };
  } catch {
    return { state: "absent", packVersion: expected.packVersion };
  }
}

/**
 * Marker written INSIDE the version directory but OUTSIDE the digested tree.
 *
 * The digest covers `<version>/<harnessId>`; this sits one level up, so
 * writing it cannot change the digest of the thing it vouches for.
 */
const INSTALL_MARKER = ".mcpjam-pack-installed.json";

interface ActiveInstall {
  status: RuntimeInstallStatus;
  promise: Promise<RuntimeInstallStatus>;
}

/** Single-flight, keyed by pack version. Two consent sheets asking to install
 *  at once must not race two extractions into the same directory. */
const active = new Map<string, ActiveInstall>();

export interface InstallRuntimePackOptions {
  harnessId: SupportedLocalHarnessId;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Progress callback for the UI. Called with monotonically increasing
   *  percentages during download only; verification has no meaningful
   *  fraction to report. */
  onProgress?: (status: RuntimeInstallStatus) => void;
  signal?: AbortSignal;
}

export async function installRuntimePack(
  options: InstallRuntimePackOptions,
): Promise<RuntimeInstallStatus> {
  const platform = currentLocalPlatform(options.platform ?? process.platform);
  if (platform === null) {
    return {
      state: "unsupported-platform",
      message: `${options.platform ?? process.platform} has no local harness runtime`,
    };
  }
  const target = localPackTarget(options.platform, options.arch);
  const expected =
    target === null ? null : expectedPackFor(options.harnessId, target);
  if (expected === null) {
    return {
      state: "unsupported-platform",
      message:
        `no ${options.harnessId} runtime pack has been built for ` +
        `${packPlatformKey(options.platform, options.arch)}`,
    };
  }

  const existing = active.get(expected.packVersion);
  if (existing !== undefined) return existing.promise;

  const record: ActiveInstall = {
    status: { state: "downloading", packVersion: expected.packVersion, percent: 0 },
    promise: Promise.resolve({
      state: "absent" as const,
      packVersion: expected.packVersion,
    }),
  };
  active.set(expected.packVersion, record);

  const setStatus = (status: RuntimeInstallStatus) => {
    record.status = status;
    options.onProgress?.(status);
  };

  record.promise = (async () => {
    try {
      return await performInstall({
        ...options,
        platform,
        expected,
        setStatus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[local-harness] runtime pack install failed", { message });
      return {
        state: "corrupt" as const,
        packVersion: expected.packVersion,
        message,
      };
    } finally {
      active.delete(expected.packVersion);
    }
  })();

  return record.promise;
}

async function performInstall(args: {
  harnessId: SupportedLocalHarnessId;
  platform: LocalPlatform;
  arch?: string;
  expected: { packVersion: string; treeDigest: string };
  setStatus: (status: RuntimeInstallStatus) => void;
  signal?: AbortSignal;
}): Promise<RuntimeInstallStatus> {
  const { expected, setStatus } = args;
  const platformKey = packPlatformKey(args.platform, args.arch);
  const target = localPackTarget(args.platform, args.arch);
  const versionRoot = packVersionRoot(expected.packVersion, target);
  // Per TARGET, so staging and the version sweep below are confined to this
  // architecture's directory and cannot touch another one's runtime.
  const installRoot = targetInstallRoot(target);
  await mkdir(installRoot, { recursive: true, mode: 0o700 });

  const staging = join(installRoot, `.mcpjam-tmp-${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });

  try {
    const source = packSourceFor(expected.packVersion, platformKey);
    const archivePath = join(staging, "pack.tar.gz");

    setStatus({ state: "downloading", packVersion: expected.packVersion, percent: 0 });
    const archiveSha = await fetchArchive({
      source,
      destination: archivePath,
      onPercent: (percent) =>
        setStatus({
          state: "downloading",
          packVersion: expected.packVersion,
          percent,
        }),
      ...(args.signal ? { signal: args.signal } : {}),
    });

    setStatus({ state: "verifying", packVersion: expected.packVersion });

    // 1. Signature over the manifest. A local development source is allowed to
    //    skip this, because it names a file the developer built themselves
    //    rather than something fetched from anywhere.
    const manifest = await loadAndVerifyManifest({
      source,
      packVersion: expected.packVersion,
      platformKey,
      staging,
    });

    // 2. The archive against the manifest.
    if (manifest !== null && manifest.archive?.sha256 !== undefined) {
      if (manifest.archive.sha256 !== archiveSha) {
        throw new Error(
          `the downloaded runtime pack archive does not match its signed ` +
            `manifest (expected ${manifest.archive.sha256}, got ${archiveSha})`,
        );
      }
    }

    // 3. Extract, then the tree against the manifest and against what this
    //    Inspector build expects. Both, because they answer different
    //    questions: the manifest says "this is the pack that was built", the
    //    build's own expectation says "and it is the pack this code was
    //    reviewed against".
    const extractRoot = join(staging, "extracted");
    await mkdir(extractRoot, { recursive: true, mode: 0o700 });
    await extractTar({
      file: archivePath,
      cwd: extractRoot,
      // No links of any kind survive extraction, and nothing may be written
      // outside `cwd`. The digest would refuse a symlink later; refusing it
      // here means it never touches the disk.
      filter: (path, entry) => {
        // Regular files and directories only. A symlink, hardlink, device or
        // fifo in the archive is refused here rather than written and then
        // rejected by the digest — extraction is where a link would do its
        // damage, so it never touches the disk.
        const type = (entry as { type?: string }).type;
        if (type !== "File" && type !== "Directory") return false;
        return !path.split("/").includes("..");
      },
      preservePaths: false,
      strict: true,
    });

    const packRoot = join(extractRoot, args.harnessId);
    const info = await stat(packRoot).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(
        `the runtime pack archive has no ${args.harnessId} directory at its root`,
      );
    }
    await assertExtractedSize(packRoot);

    const digest = await computeTreeDigest(packRoot);
    if (manifest !== null && digest !== manifest.treeDigest) {
      throw new Error(
        `the extracted runtime pack does not match its signed manifest ` +
          `(expected ${manifest.treeDigest}, got ${digest})`,
      );
    }
    if (digest !== expected.treeDigest) {
      throw new Error(
        `the runtime pack does not match the digest this Inspector was ` +
          `built with (expected ${expected.treeDigest}, got ${digest})`,
      );
    }

    // macOS quarantines files written by a downloading process. The vendor's
    // binary and Node are both Developer-ID signed with hardened runtime, so
    // the quarantine flag is the only thing standing between a verified pack
    // and Gatekeeper refusing to exec it. Cleared only on the tree this
    // install just wrote and just verified.
    if (args.platform === "darwin") await clearQuarantine(extractRoot);

    // Activate. The rename is the commit point: before it there is no version
    // directory at all, after it there is a complete verified one.
    await rm(versionRoot, { recursive: true, force: true });
    await rename(extractRoot, versionRoot);
    await writeFile(
      join(versionRoot, INSTALL_MARKER),
      `${JSON.stringify(
        {
          packVersion: expected.packVersion,
          harnessId: args.harnessId,
          platform: platformKey,
          treeDigest: digest,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    // A previous process may have verified a DIFFERENT tree at this path.
    clearRuntimeVerificationCache();
    await sweepOtherVersions(installRoot, expected.packVersion);

    logger.info("[local-harness] runtime pack installed", {
      packVersion: expected.packVersion,
      platform: platformKey,
    });
    return {
      state: "ready",
      packVersion: expected.packVersion,
      runtimeRoot: versionRoot,
      digest,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function assertExtractedSize(root: string): Promise<void> {
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      bytes += (await stat(full)).size;
      if (bytes > MAX_EXTRACTED_BYTES) {
        throw new Error("the extracted runtime pack exceeds its size ceiling");
      }
    }
  };
  await walk(root);
}

/**
 * Remove versions other than the one just activated.
 *
 * Kept simple on purpose: rollback is "install the previous version again",
 * not "keep N around and switch between them". A pack is 515 MB, and a
 * silently-accumulating set of them on a user's disk is a worse failure than
 * a reinstall.
 */
async function sweepOtherVersions(
  installRoot: string,
  keepVersion: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(installRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === keepVersion) continue;
    const path = join(installRoot, entry);
    // Only directories this installer created. `MCPJAM_RUNTIME_ROOT` is an
    // override — an operator, or a future Electron change, could point it at a
    // directory holding other application state, and a name-shaped filter
    // ("looks like a version") would then delete it. A staging directory
    // carries our prefix; an activated version carries the marker the install
    // wrote after verifying. Anything else is not ours to remove, whatever it
    // is called.
    if (entry.startsWith(".mcpjam-tmp-")) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!/^[\w.-]+$/.test(entry)) continue;
    const owned = await readFile(join(path, INSTALL_MARKER), "utf8").then(
      () => true,
      () => false,
    );
    if (!owned) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

async function clearQuarantine(root: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolvePromise) => {
    execFile(
      "/usr/bin/xattr",
      ["-r", "-d", "com.apple.quarantine", root],
      { timeout: 60_000 },
      () => resolvePromise(),
    );
  });
}

/**
 * Load the pack manifest and prove it is ours.
 *
 * Returns `null` ONLY for a local development source, where the "download" is
 * a file the developer built and named explicitly. Every network source must
 * produce a signed manifest or the install fails.
 */
async function loadAndVerifyManifest(args: {
  source: { kind: "file" | "url"; location: string };
  packVersion: string;
  platformKey: string;
  staging: string;
}): Promise<PackManifest | null> {
  const stem = `local-harness-pack-${args.platformKey}-${args.packVersion}`;
  const manifestName = `${stem}.manifest.json`;
  const signatureName = `${manifestName}.sig`;

  let manifestBytes: Buffer;
  let signature: string;
  try {
    if (args.source.kind === "file") {
      const dir = args.source.location.endsWith(".tar.gz")
        ? args.source.location.slice(0, -basename(args.source.location).length)
        : args.source.location;
      manifestBytes = await readFile(join(dir, manifestName));
      signature = await readFile(join(dir, signatureName), "utf8");
    } else {
      const base = args.source.location.slice(
        0,
        args.source.location.lastIndexOf("/") + 1,
      );
      manifestBytes = Buffer.from(
        await (await fetchOrThrow(base + manifestName)).arrayBuffer(),
      );
      signature = await (await fetchOrThrow(base + signatureName)).text();
    }
  } catch (error) {
    if (args.source.kind === "file") {
      logger.warn(
        "[local-harness] local pack source has no signed manifest; " +
          "installing on the digest alone",
        { message: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
    throw new Error(
      `the runtime pack has no signed manifest alongside it, so it cannot ` +
        `be shown to have come from MCPJam`,
    );
  }

  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("the runtime pack manifest is implausibly large");
  }
  const verified = verifyPackManifestSignature(manifestBytes, signature);
  if (!verified.ok) {
    if (args.source.kind === "file") {
      logger.warn(
        "[local-harness] local pack manifest signature not verified; " +
          "installing on the digest alone",
        { reason: verified.reason },
      );
      return null;
    }
    throw new Error(verified.message);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as PackManifest;
  if (manifest.packVersion !== args.packVersion) {
    throw new Error(
      `the signed manifest is for pack version ${manifest.packVersion}, not ` +
        `${args.packVersion}`,
    );
  }
  if (manifest.platform !== args.platformKey) {
    throw new Error(
      `the signed manifest is for ${manifest.platform}, not ${args.platformKey}`,
    );
  }
  return manifest;
}

async function fetchOrThrow(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response;
}

/**
 * Stream the archive to disk, hashing as it goes.
 *
 * Streamed rather than buffered because the archive is 150-200 MB and holding
 * it in memory on a laptop that is also running an agent is not free. The hash
 * is computed on the way past, so verification does not mean reading it again.
 */
async function fetchArchive(args: {
  source: { kind: "file" | "url"; location: string };
  destination: string;
  onPercent: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const hash = createHash("sha256");
  let received = 0;
  let total = 0;

  const track = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error("the runtime pack archive exceeds its size ceiling");
      }
      if (total > 0) {
        args.onPercent(Math.min(99, Math.floor((received / total) * 100)));
      }
      controller.enqueue(chunk);
    },
  });

  if (args.source.kind === "file") {
    const path = args.source.location;
    const info = await stat(path);
    total = info.size;
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error("the runtime pack archive exceeds its size ceiling");
    }
    await pipeline(
      createReadStream(path),
      async function* (chunks) {
        for await (const chunk of chunks) {
          const buffer = chunk as Buffer;
          hash.update(buffer);
          received += buffer.byteLength;
          args.onPercent(Math.min(99, Math.floor((received / total) * 100)));
          yield buffer;
        }
      },
      createWriteStream(args.destination, { mode: 0o600 }),
    );
    return hash.digest("hex");
  }

  const response = await fetch(args.source.location, {
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!response.ok || response.body === null) {
    throw new Error(
      `the runtime pack could not be downloaded: ${args.source.location} ` +
        `responded ${response.status}`,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new Error("the runtime pack archive exceeds its size ceiling");
  }
  total = declared;

  await pipeline(
    Readable.fromWeb(
      response.body.pipeThrough(track) as Parameters<typeof Readable.fromWeb>[0],
    ),
    createWriteStream(args.destination, { mode: 0o600 }),
  );
  args.onPercent(100);
  return hash.digest("hex");
}

/**
 * Startup hook: report what is installed, and never install anything.
 *
 * Mirrors `startLocalBrowserRenderingSetupInBackground`'s shape but not its
 * behaviour — Chromium is a dependency the eval path cannot work without, so
 * fetching it unasked is defensible; a 515 MB agent runtime for a feature
 * behind a flag, a kill switch and a consent grant is not. This exists so the
 * availability route and the UI have an answer without doing work, and so an
 * operator sees in the log whether a pack is present.
 */
export function reportLocalHarnessRuntimeStatusInBackground(): void {
  void (async () => {
    try {
      const status = await readRuntimeInstallStatus({
        harnessId: "claude-code",
      });
      if (status.state === "ready") {
        logger.info("[local-harness] runtime pack present", {
          packVersion: status.packVersion,
        });
        return;
      }
      logger.debug("[local-harness] no runtime pack installed", {
        state: status.state,
        expected: EXPECTED_PACK_VERSION || "(none built)",
      });
    } catch {
      // Reporting is best-effort by construction: a status probe that throws
      // must not affect server startup.
    }
  })();
}
