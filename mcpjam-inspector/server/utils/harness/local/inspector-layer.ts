/**
 * The Inspector layer: the half of a local harness runtime that is MCPJam's
 * own code, delivered WITH THE INSPECTOR rather than inside a vendor pack.
 *
 * ── Why split it out ─────────────────────────────────────────────────────
 * A pack used to carry our ~53 KB bridge next to ~494 MB of vendor runtime,
 * so every bridge edit meant a new pack, a new release, a new pin — and a user
 * re-downloading half a gigabyte for a file they already had. Now a pack is
 * vendor bytes only (`bin/node`, the vendor CLI/SDK, the Windows job launcher)
 * and the layer — the launcher, the bridge, Codex's host-tools MCP entrypoint
 * — is compiled into the Inspector (`layer/generated/*.bundled.ts`) and
 * written here at run time. A bridge change is an ordinary Inspector change,
 * for Claude Code and Codex alike.
 *
 * ── Two trusted sources (invariant 1) ────────────────────────────────────
 * Every executable byte comes from a verified vendor pack (signature, archive
 * sha, tree digest) or from the Inspector distribution itself. The layer is the
 * second kind, and the rules here are what keep it that way once it is on disk:
 *
 *   - CONTENT-ADDRESSED. The directory is named by the tree digest of its files
 *     (`<runtimeRoot>/inspector-layer/<hex>/`), and that digest is computed from
 *     the bytes compiled into THIS build (`digestFileSet`), never read back from
 *     disk. Two Inspector versions with different bridges get two directories.
 *   - READ-ONLY. Files are 0444 and the directory 0555. Not a security boundary
 *     against a process running as the same user — nothing here is — but it
 *     turns an accidental write into an error.
 *   - OUTSIDE EVERY SESSION ROOT, and named in every session's denied roots
 *     (`session-env.ts`), so the agent's own file tools are told to stay out.
 *   - RE-HASHED BEFORE EVERY EXEC against the compiled digest, exactly as
 *     `revalidateRuntime` re-checks pack files. The layer is a few hundred KB,
 *     so this is a full digest every time rather than a stat snapshot.
 *
 * A directory that exists but does not match is REPLACED when the layer is
 * ensured (the correct bytes are right here in the build), and refused when a
 * spawn is about to happen (`verifyInspectorLayer`): tampering between
 * resolution and exec fails closed, it is never healed under a running session.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import {
  INSPECTOR_LAYER_DIRNAME,
  inspectorLayerDigest,
  inspectorLayerFiles,
} from "./inspector-layer-files.js";
import { runtimeInstallRoot } from "./runtime-root.js";
import type { SupportedLocalHarnessId } from "./targets.js";
import { computeTreeDigest } from "./tree-digest.js";

export {
  INSPECTOR_LAYER_DIRNAME,
  INSPECTOR_LAYER_SCHEMA,
  inspectorLayerDigest,
  inspectorLayerFiles,
  inspectorLayerRecipe,
  inspectorLayerRecipeFiles,
  type InspectorLayerFile,
} from "./inspector-layer-files.js";

const STAGING_PREFIX = ".mcpjam-tmp-";
const RETIRED_PREFIX = ".mcpjam-retired-";

/** Where layers live for a runtime root. */
export function inspectorLayerBase(runtimeRoot: string = runtimeInstallRoot()): string {
  return join(runtimeRoot, INSPECTOR_LAYER_DIRNAME);
}

export interface InspectorLayer {
  harnessId: SupportedLocalHarnessId;
  /** Absolute layer directory. Local trusted state — never sent to a renderer. */
  root: string;
  digest: string;
  launcherPath: string;
  /** Relative names of every file the layer holds. */
  files: readonly string[];
}

export type InspectorLayerResult =
  | { ok: true; layer: InspectorLayer }
  | { ok: false; message: string };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Make a read-only tree removable again, then remove it. Best effort. */
export async function removeReadOnlyTree(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => {});
  for (const name of await readdir(path).catch(() => [] as string[])) {
    await chmod(join(path, name), 0o600).catch(() => {});
  }
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

/**
 * Write (or repair) this build's layer for a harness and return where it is.
 *
 * Idempotent and safe across processes: the tree is written to a staging
 * directory, verified against the compiled digest, made read-only, and renamed
 * into place. Losing the rename to another process that wrote the same digest
 * is success, after that directory verifies too.
 */
export async function ensureInspectorLayer(
  harnessId: SupportedLocalHarnessId,
  options: { runtimeRoot?: string } = {},
): Promise<InspectorLayerResult> {
  const files = inspectorLayerFiles(harnessId);
  const digest = inspectorLayerDigest(harnessId);
  if (files === null || digest === null) {
    return { ok: false, message: `${harnessId} has no Inspector layer in this build` };
  }
  const base = inspectorLayerBase(options.runtimeRoot);
  const root = join(base, digest.slice("sha256:".length));
  // CANONICAL, like a pack root: the provider compares it against the
  // session's writable roots, and a symlinked runtime root (macOS's
  // /var -> /private/var) would otherwise never match its own children.
  const done = async (): Promise<InspectorLayerResult> => {
    const canonical = await realpath(root);
    return {
      ok: true,
      layer: {
        harnessId,
        root: canonical,
        digest,
        launcherPath: join(canonical, "launcher.mjs"),
        files: files.map((file) => file.path),
      },
    };
  };

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await exists(root)) {
        const onDisk = await computeTreeDigest(root).catch(() => null);
        if (onDisk === digest) return done();
        // Present and wrong: the bytes that belong there are compiled into
        // this build, so put them back rather than refusing every session.
        // Moved aside first so a concurrent reader never sees a half-removed
        // tree; whoever loses the rename simply re-checks.
        logger.warn("[local-harness] replacing an Inspector layer that does not match its digest", {
          harnessId,
        });
        const retired = join(base, `${RETIRED_PREFIX}${randomUUID()}`);
        try {
          await rename(root, retired);
        } catch {
          continue;
        }
        await removeReadOnlyTree(retired);
        continue;
      }

      await mkdir(base, { recursive: true, mode: 0o700 });
      const staging = join(base, `${STAGING_PREFIX}${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        for (const file of files) {
          const path = join(staging, file.path);
          await writeFile(path, file.content, { mode: 0o444 });
          // Explicit, not via `writeFile`'s mode: that one is masked by the
          // umask, and the exec bit is part of the digest.
          await chmod(path, 0o444);
        }
        const staged = await computeTreeDigest(staging);
        if (staged !== digest) {
          throw new Error(
            `the Inspector layer did not digest as compiled (expected ${digest}, wrote ${staged})`,
          );
        }
        await chmod(staging, 0o555);
        try {
          await rename(staging, root);
          return done();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Another process won the race to the same content address.
          if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
        }
      } finally {
        if (await exists(staging)) await removeReadOnlyTree(staging);
      }
    }
    // Three rounds of somebody else rewriting the directory under us.
    if ((await computeTreeDigest(root).catch(() => null)) === digest) {
      return done();
    }
    return {
      ok: false,
      message: `the ${harnessId} Inspector layer at ${root} kept changing while it was being written`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `the ${harnessId} Inspector layer could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Re-hash a layer against the digest compiled into this build, immediately
 * before an exec. Never repairs: a layer that changed after it was resolved is
 * a refusal, not something to fix underneath a session.
 */
export async function verifyInspectorLayer(
  layer: Pick<InspectorLayer, "harnessId" | "root" | "digest">,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const compiled = inspectorLayerDigest(layer.harnessId);
  if (compiled === null || compiled !== layer.digest) {
    return {
      ok: false,
      message:
        `the ${layer.harnessId} Inspector layer this session resolved is not ` +
        `the one compiled into this Inspector`,
    };
  }
  const onDisk = await computeTreeDigest(layer.root).catch((error: unknown) => {
    return error instanceof Error ? `unreadable: ${error.message}` : "unreadable";
  });
  if (onDisk !== compiled) {
    return {
      ok: false,
      message:
        `the ${layer.harnessId} Inspector layer changed after it was verified ` +
        `(expected ${compiled}, found ${onDisk})`,
    };
  }
  return { ok: true };
}
