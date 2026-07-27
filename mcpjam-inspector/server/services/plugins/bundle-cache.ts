/**
 * `PluginBundleCache` — the verified, content-addressed local bundle cache
 * (INS-6, "Inspector local materializer").
 *
 * A plugin's local stdio component cannot run from Convex storage: something on
 * this machine must hold the bundle's files so `${PLUGIN_ROOT}` can point at
 * them. This is that something, and its whole contract is:
 *
 *   - CONTENT-ADDRESSED. The entry directory is keyed by `bundleHash`, so a
 *     re-import that changes one byte is a different entry. Nothing is ever
 *     mutated in place, which is what makes "no local absolute source path is
 *     required after materialization" true: the path is derived from identity
 *     the backend already stores (project / plugin / bundle hash), never from
 *     wherever the user happened to keep the folder.
 *   - VERIFIED WITH THE SDK'S OWN HASH. Verification re-parses the extracted
 *     directory through `parsePluginBundle` and compares the `bundleHash` it
 *     computes. That is deliberately the SDK's hashing (the SDK keeps the
 *     primitives module-private and exposes them exactly this way), not a
 *     second implementation that could drift from what the backend pinned —
 *     the INS-1 hand-copied-mirror mistake, which a follow-up PR had to retire.
 *     It also means tampering of ANY kind (edited file, added file, deleted
 *     file) fails, because the hash covers every path and its bytes.
 *   - ATOMIC. Extraction happens in a sibling temp directory that is verified
 *     BEFORE a single `rename` publishes it, so a crash mid-extract can never
 *     leave a half-bundle at a hash-named path where a later launch would
 *     trust it.
 *   - INERT. Files are written and nothing else: no install script, no
 *     lifecycle hook, no `npm install`. A bundle is data until a user launches
 *     a component that the environment resolution already authorized.
 *
 * The cache holds BUNDLE CONTENT, which is immutable by construction. It is
 * emphatically not a resolution cache — which pinned versions may run is
 * re-decided backend-side on every launch so disable/uninstall bite
 * immediately, and nothing here is consulted for that question.
 */
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  DEFAULT_PLUGIN_BUNDLE_LIMITS,
  parsePluginBundle,
  type ParsedPluginBundle,
  type PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import { logger } from "../../utils/logger.js";
import { createDirectoryPluginFileSource } from "./bundle-file-sources.js";

export type PluginBundleCacheErrorCode =
  /** Extracted (or offered) content does not hash to the pinned `bundleHash`. */
  | "hash_mismatch"
  /** Nothing cached for this identity and no source was offered to seed it. */
  | "not_cached"
  /** Content is not a parseable plugin bundle at all. */
  | "invalid_bundle";

export class PluginBundleCacheError extends Error {
  readonly code: PluginBundleCacheErrorCode;
  constructor(code: PluginBundleCacheErrorCode, message: string) {
    super(message);
    this.name = "PluginBundleCacheError";
    this.code = code;
  }
}

/** Everything needed to name a cache entry — all of it backend-owned identity. */
export interface PluginBundleIdentity {
  projectId: string;
  /**
   * The immutable version, not the mutable plugin: it is the ONE identifier
   * both writers have without an extra lookup — the import flow gets it from
   * `commitImport`, the launch path from runtime attribution.
   */
  pluginVersionId: string;
  /** The immutable version's `bundleHash`, as pinned by the backend. */
  bundleHash: string;
}

export interface MaterializedPluginBundle {
  /** Absolute path the `${PLUGIN_ROOT}` placeholders resolve to. */
  root: string;
  bundleHash: string;
  /** The verified parse — callers read `mcpServers` from here, never re-parse. */
  parsed: ParsedPluginBundle;
}

const TEMP_PREFIX = ".mcpjam-tmp-";

/** `~/.mcpjam/plugins` — the plan's cache root. */
export function defaultPluginCacheRoot(): string {
  return join(homedir(), ".mcpjam", "plugins");
}

/**
 * One path segment per identity component, sanitized so a hostile id cannot
 * escape the cache root. Convex ids and hex hashes are already
 * `[A-Za-z0-9_-]`, so this is a no-op for real input and a hard stop for
 * anything else — cheaper and more predictable than a realpath round-trip.
 */
function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new PluginBundleCacheError(
      "invalid_bundle",
      `Refusing to build a cache path from an unsafe ${label}: "${value}"`
    );
  }
  return value;
}

export class PluginBundleCache {
  private readonly rootDir: string;
  /**
   * entry path → live lease ids. A lease means "a local session may spawn a
   * process rooted here", so GC must not delete the entry out from under it —
   * a running stdio server would lose its own files mid-flight.
   */
  private readonly leases = new Map<string, Set<string>>();

  constructor(options?: { rootDir?: string }) {
    this.rootDir = options?.rootDir ?? defaultPluginCacheRoot();
  }

  /** Absolute path of the entry for one immutable bundle. */
  entryPath(identity: PluginBundleIdentity): string {
    return join(
      this.rootDir,
      safeSegment(identity.projectId, "project id"),
      safeSegment(identity.pluginVersionId, "plugin version id"),
      safeSegment(identity.bundleHash, "bundle hash")
    );
  }

  /**
   * Return a verified entry, extracting `source` first when the entry is not
   * cached yet.
   *
   * A cache HIT is re-verified, not trusted: the entry lives in the user's home
   * directory where anything can edit it, and the acceptance criterion is
   * exactly that tampered cache content fails. Verification cost is a re-hash
   * of a small bundle at connect time, which is the right side of that trade.
   */
  async materialize(
    identity: PluginBundleIdentity,
    options?: { source?: PluginFileSource }
  ): Promise<MaterializedPluginBundle> {
    const root = this.entryPath(identity);
    const cached = await directoryExists(root);

    if (cached) {
      try {
        const parsed = await this.verifyEntry(root, identity.bundleHash);
        return { root, bundleHash: identity.bundleHash, parsed };
      } catch (error) {
        if (!options?.source) throw error;
        // A source lets us recover from a corrupted entry instead of dead-ending
        // the user: drop the bad copy and extract a fresh, verified one.
        logger.warn(
          "[plugin-cache] cached bundle failed verification; re-materializing",
          {
            bundleHash: identity.bundleHash,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        await rm(root, { recursive: true, force: true });
      }
    }

    if (!options?.source) {
      throw new PluginBundleCacheError(
        "not_cached",
        `Plugin bundle ${identity.bundleHash} is not materialized on this machine`
      );
    }

    const parsed = await parseOrThrow(options.source);
    // Check BEFORE writing: content that does not match the pin never touches
    // the cache, not even under a temp name.
    if (parsed.bundleHash !== identity.bundleHash) {
      throw new PluginBundleCacheError(
        "hash_mismatch",
        `Bundle content hashes to ${parsed.bundleHash}, expected ${identity.bundleHash}`
      );
    }

    await mkdir(dirname(root), { recursive: true });
    const tempRoot = await mkdtemp(join(dirname(root), TEMP_PREFIX));
    try {
      await extractInto(tempRoot, options.source);
      // Verify what actually landed on disk, not what we believed we wrote.
      const verified = await this.verifyEntry(tempRoot, identity.bundleHash);
      try {
        await rename(tempRoot, root);
      } catch (error) {
        // Another materialization of the SAME immutable hash won the race and
        // published first. Its content is verified by the same rule ours was,
        // so adopt it rather than clobbering a directory a live session may
        // already be running from.
        if (!(await directoryExists(root))) throw error;
        await rm(tempRoot, { recursive: true, force: true });
        const adopted = await this.verifyEntry(root, identity.bundleHash);
        return { root, bundleHash: identity.bundleHash, parsed: adopted };
      }
      return { root, bundleHash: identity.bundleHash, parsed: verified };
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Re-parse an extracted directory and assert its hash. Throws
   * `hash_mismatch` for tampered content and `invalid_bundle` when the
   * directory no longer parses as a bundle at all (a deleted manifest, a
   * symlink someone dropped in).
   */
  async verifyEntry(
    root: string,
    expectedBundleHash: string
  ): Promise<ParsedPluginBundle> {
    const parsed = await parseOrThrow(createDirectoryPluginFileSource(root));
    if (parsed.bundleHash !== expectedBundleHash) {
      throw new PluginBundleCacheError(
        "hash_mismatch",
        `Cached bundle at ${root} hashes to ${parsed.bundleHash}, expected ${expectedBundleHash}`
      );
    }
    return parsed;
  }

  /**
   * Pin an entry for the lifetime of a local session. Returns the release
   * function; callers MUST call it (disconnect / process exit) or the entry
   * stays un-collectable for the life of the inspector process.
   */
  acquire(identity: PluginBundleIdentity, leaseId: string): () => void {
    const key = this.entryPath(identity);
    const holders = this.leases.get(key) ?? new Set<string>();
    holders.add(leaseId);
    this.leases.set(key, holders);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.leases.get(key);
      if (!current) return;
      current.delete(leaseId);
      if (current.size === 0) this.leases.delete(key);
    };
  }

  /** Entry paths currently referenced by a local session. */
  activeEntries(): string[] {
    return [...this.leases.keys()];
  }

  /**
   * Delete cache entries no live session references.
   *
   * `keep` is the set of bundle hashes the caller still considers pinned
   * (typically the hashes of the versions the backend just resolved). Anything
   * outside it AND unleased is a leftover from an older revision. Leftover temp
   * directories are swept too — they are, by construction, unverified.
   */
  async collectGarbage(options?: {
    keepBundleHashes?: Iterable<string>;
  }): Promise<{ removed: string[] }> {
    const keep = new Set(options?.keepBundleHashes ?? []);
    const leased = new Set(this.activeEntries());
    const removed: string[] = [];

    for (const projectDir of await listSubdirectories(this.rootDir)) {
      for (const pluginDir of await listSubdirectories(projectDir)) {
        for (const entryDir of await listSubdirectories(pluginDir)) {
          const name = entryDir.slice(entryDir.lastIndexOf(sep) + 1);
          if (name.startsWith(TEMP_PREFIX)) {
            await rm(entryDir, { recursive: true, force: true });
            removed.push(entryDir);
            continue;
          }
          // An entry a session is running from stays, even when the pin moved
          // on: deleting it would pull the files out from under a live process.
          if (leased.has(entryDir) || keep.has(name)) continue;
          await rm(entryDir, { recursive: true, force: true });
          removed.push(entryDir);
        }
      }
    }
    return { removed };
  }
}

async function parseOrThrow(
  source: PluginFileSource
): Promise<ParsedPluginBundle> {
  try {
    return await parsePluginBundle(source);
  } catch (error) {
    throw new PluginBundleCacheError(
      "invalid_bundle",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Write every file the source lists into `target`. Paths were already
 * validated by the parse that preceded this call (the SDK rejects absolute
 * paths, `..`, and link entries before any content is read); the containment
 * assertion here is a belt-and-braces check on the one operation that would be
 * unrecoverable if that ever regressed.
 */
async function extractInto(
  target: string,
  source: PluginFileSource
): Promise<void> {
  const entries = await source.list();
  for (const entry of entries) {
    if (entry.kind === "directory") continue;
    const destination = resolve(target, entry.path);
    if (
      destination !== resolve(target) &&
      !destination.startsWith(resolve(target) + sep)
    ) {
      throw new PluginBundleCacheError(
        "invalid_bundle",
        `Bundle entry "${entry.path}" escapes the cache entry directory`
      );
    }
    const bytes = await source.readBytes(
      entry.path,
      DEFAULT_PLUGIN_BUNDLE_LIMITS.maxFileBytes
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listSubdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}
