import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_HARNESS_MANIFEST,
  type LocalHarnessCompatibility,
} from "../compatibility.js";
import {
  clearRuntimeVerificationCache,
  computeTreeDigest,
  resolveManagedBundle,
  resolveSystemInstall,
  revalidateRuntime,
  systemInstallSearchPaths,
  verifyRuntime,
} from "../runtime-identity.js";

let base: string;
let runtimeRoot: string;

/**
 * A pack always carries a launcher and its own `bin/node`; both are required
 * for a bundle to resolve, so the fixtures add them unless a test is
 * specifically about their absence.
 */
async function writeBundle(
  name: string,
  files: Record<string, string>,
  opts: { omitLauncher?: boolean; omitNode?: boolean } = {},
) {
  const root = join(runtimeRoot, name);
  const all: Record<string, string> = { ...files };
  if (!opts.omitLauncher && all["launcher.mjs"] === undefined) {
    all["launcher.mjs"] = 'await import("./bridge.mjs");';
  }
  if (!opts.omitNode && all["bin/node"] === undefined) {
    all["bin/node"] = "#!/bin/sh\nexit 0\n";
  }
  for (const [rel, content] of Object.entries(all)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  if (!opts.omitNode) await chmod(join(root, "bin/node"), 0o755);
  return root;
}

function manifestFor(
  bundleName: string,
  digest: string,
): LocalHarnessCompatibility {
  return {
    ...LOCAL_HARNESS_MANIFEST["claude-code"],
    runtime: {
      source: "managed-bundle",
      bundleName,
      // Per platform, because a pack is: it carries a platform-specific Node
      // and a platform-specific vendor binary.
      bundleDigest: {
        // Every target, so a fixture built on one machine resolves on any
        // other: the lookup is by `<os>-<arch>` and a partial map would
        // make these tests pass or fail by architecture.
        "linux-x64": digest,
        "linux-arm64": digest,
        "darwin-arm64": digest,
        "darwin-x64": digest,
        "win32-x64": digest,
      },
      launcherRelativePath: "launcher.mjs",
      nodeLauncherRelativePath: "bin/node",
      vendorPackages: { "@anthropic-ai/claude-code": "1.2.3" },
    },
  };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-runtime-")));
  runtimeRoot = join(base, "runtimes");
  await mkdir(runtimeRoot, { recursive: true });
});

describe("tree digests", () => {
  it("is stable for identical content and changes with any byte", async () => {
    const a = await writeBundle("stable-a", {
      "bridge.mjs": "x",
      "lib/b.js": "y",
    });
    const b = await writeBundle("stable-b", {
      "bridge.mjs": "x",
      "lib/b.js": "y",
    });
    expect(await computeTreeDigest(a)).toBe(await computeTreeDigest(b));

    const c = await writeBundle("stable-c", {
      "bridge.mjs": "x",
      "lib/b.js": "z",
    });
    expect(await computeTreeDigest(c)).not.toBe(await computeTreeDigest(a));
  });

  it("notices a file becoming executable, not just its content", async () => {
    const root = await writeBundle("mode", { "bridge.mjs": "x" });
    const before = await computeTreeDigest(root);
    await chmod(join(root, "bridge.mjs"), 0o755);
    expect(await computeTreeDigest(root)).not.toBe(before);
  });

  it("notices a renamed file", async () => {
    const a = await writeBundle("name-a", { "bridge.mjs": "x" });
    const b = await writeBundle("name-b", { "bridge2.mjs": "x" });
    expect(await computeTreeDigest(a)).not.toBe(await computeTreeDigest(b));
  });

  it("refuses to digest a bundle containing a symlink", async () => {
    const root = await writeBundle("linked", { "bridge.mjs": "x" });
    await symlink("/etc", join(root, "escape"));
    await expect(computeTreeDigest(root)).rejects.toThrow(/symlink/);
  });
});

describe("managed bundles", () => {
  it("resolves a bundle whose tree matches the manifest digest", async () => {
    const root = await writeBundle("good", { "bridge.mjs": "console.log(1)" });
    const digest = await computeTreeDigest(root);
    const result = await resolveManagedBundle({
      manifest: manifestFor("good", digest),
      runtimeRoot,
      platform: "linux",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtime.runtimeId).toMatch(/^rt_/);
    expect(result.runtime.launcherPath).toBe(join(root, "launcher.mjs"));
    expect(result.runtime.nodePath).toBe(join(root, "bin", "node"));
    expect(result.runtime.digest).toBe(digest);
  });

  it("looks for `bin/node.exe` on win32, which is what the pack actually ships", async () => {
    // The manifest names one relative path; the platform supplies the
    // extension, exactly as `build-local-harness-pack.mjs` writes it. They
    // disagreed: every Windows conformance run verified the tree and then
    // refused it as `bundle-corrupt` for a Node binary that was sitting right
    // there under its real name.
    const root = await writeBundle("win-node", {
      "bridge.mjs": "x",
      "bin/node.exe": "#!windows",
    });
    const digest = await computeTreeDigest(root);
    const result = await resolveManagedBundle({
      manifest: manifestFor("win-node", digest),
      runtimeRoot,
      platform: "win32",
      arch: "x64",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtime.nodePath).toBe(join(root, "bin", "node.exe"));
  });

  it("refuses a win32 bundle that ships only the extensionless `bin/node`", async () => {
    // The other half of the same claim: the platform's extension is required,
    // not merely preferred, so a tree carrying the POSIX name cannot satisfy a
    // Windows resolution by accident.
    const root = await writeBundle("win-node-missing", {
      "bridge.mjs": "x",
      "bin/node": "#!not-an-exe",
    });
    const result = await resolveManagedBundle({
      manifest: manifestFor("win-node-missing", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "win32",
      arch: "x64",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-corrupt" });
  });

  it("binds the runtime id to the digest, so a changed bundle is a new runtime", async () => {
    const root = await writeBundle("rebind", { "bridge.mjs": "a" });
    const first = await resolveManagedBundle({
      manifest: manifestFor("rebind", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    await writeFile(join(root, "bridge.mjs"), "b");
    const second = await resolveManagedBundle({
      manifest: manifestFor("rebind", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.runtime.runtimeId).not.toBe(second.runtime.runtimeId);
  });

  it("reports an absent bundle with an actionable message", async () => {
    const result = await resolveManagedBundle({
      manifest: manifestFor("missing", "sha256:whatever"),
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-absent" });
    expect((result as { message: string }).message).toMatch(
      /Nothing is installed while a session starts/,
    );
  });

  it("fails closed on a digest mismatch rather than launching", async () => {
    const root = await writeBundle("tampered", { "bridge.mjs": "original" });
    const manifest = manifestFor("tampered", await computeTreeDigest(root));
    await writeFile(join(root, "bridge.mjs"), "backdoored");
    const result = await resolveManagedBundle({
      manifest,
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({
      ok: false,
      status: "bundle-digest-mismatch",
    });
  });

  it("cannot resolve a platform the shipped manifest has no pack digest for", async () => {
    // The shipped manifest carries no digests until the pack build runs, so it
    // cannot enable a runtime by accident even if a bundle directory exists.
    await writeBundle("claude-code", { "bridge.mjs": "x" });
    const result = await resolveManagedBundle({
      manifest: LOCAL_HARNESS_MANIFEST["claude-code"],
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-absent" });
    expect((result as { message: string }).message).toMatch(
      /no digest to verify one against/,
    );
  });

  it("refuses a launcher path that climbs out of the digested tree", async () => {
    const root = await writeBundle("escape", { "bridge.mjs": "x" });
    const manifest = manifestFor("escape", await computeTreeDigest(root));
    const result = await resolveManagedBundle({
      manifest: {
        ...manifest,
        runtime: {
          ...manifest.runtime,
          launcherRelativePath: "../outside.mjs",
        },
      } as LocalHarnessCompatibility,
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-corrupt" });
    expect((result as { message: string }).message).toMatch(
      /outside the bundle whose digest was verified/,
    );
  });

  it("reports a bundle with no launcher as corrupt", async () => {
    const root = await writeBundle(
      "nolauncher",
      { "lib/x.js": "x" },
      { omitLauncher: true },
    );
    const result = await resolveManagedBundle({
      manifest: manifestFor("nolauncher", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-corrupt" });
  });

  it("refuses a pack with no Node binary of its own", async () => {
    // Both distributions launch the bridge with the pack's `bin/node`: the
    // Electron `RunAsNode` fuse is off, and the npx server's own execPath is
    // outside the tree the digest covers.
    const root = await writeBundle(
      "nonode",
      { "bridge.mjs": "x" },
      { omitNode: true },
    );
    const result = await resolveManagedBundle({
      manifest: manifestFor("nonode", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-corrupt" });
    expect((result as { message: string }).message).toMatch(/Node binary/);
  });

  it("refuses a Node binary that is not executable", async () => {
    const root = await writeBundle("dudnode", { "bridge.mjs": "x" });
    await chmod(join(root, "bin/node"), 0o644);
    const result = await resolveManagedBundle({
      manifest: manifestFor("dudnode", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-corrupt" });
  });
});

describe("verification cost", () => {
  it("digests a pack once per process and answers from cache after that", async () => {
    // The measured defect: five full digests of a 515 MB tree per session
    // start, 0.6-1.5 s each, for a tree the session cannot write to.
    clearRuntimeVerificationCache();
    const root = await writeBundle("cached", { "bridge.mjs": "x" });
    const digest = await computeTreeDigest(root);

    const first = await verifyRuntime(root, digest);
    expect(first).toMatchObject({ ok: true, cached: false });
    const second = await verifyRuntime(root, digest);
    expect(second).toMatchObject({ ok: true, cached: true });
  });

  it("digests once when two callers race, not twice", async () => {
    // The path the completed-results cache alone does not cover: both callers
    // start before the first digest returns, so both miss it and both read the
    // whole tree. On a 494 MB pack that is 3 s each.
    clearRuntimeVerificationCache();
    const root = await writeBundle("concurrent", { "bridge.mjs": "x" });
    const digest = await computeTreeDigest(root);
    clearRuntimeVerificationCache();

    const [first, second] = await Promise.all([
      verifyRuntime(root, digest),
      verifyRuntime(root, digest),
    ]);
    // The SAME result object: one verification, awaited twice.
    expect(first).toBe(second);
    expect(first).toMatchObject({ ok: true, cached: false });
  });

  it("never remembers a verification that failed, even a concurrent one", async () => {
    // A promise cache that kept failures would answer "no" forever for a tree
    // that was merely wrong for a moment.
    //
    // The SAME (root, expectedDigest) key throughout, which is the only way
    // this can test anything: the cache is keyed on the pair, so a version
    // that failed against one digest and retried against another exercised two
    // unrelated entries and would have passed even if failures were cached
    // forever.
    clearRuntimeVerificationCache();
    const root = await writeBundle("concurrent-bad", { "bridge.mjs": "x" });
    const wanted = await computeTreeDigest(root);
    clearRuntimeVerificationCache();

    // Same key, but the tree does not match it yet.
    await writeFile(join(root, "bridge.mjs"), "not-x-yet");
    const failures = await Promise.all([
      verifyRuntime(root, wanted),
      verifyRuntime(root, wanted),
    ]);
    for (const failure of failures) {
      expect(failure).toMatchObject({ ok: false, reason: "digest-mismatch" });
    }

    // The tree becomes what that key names. A cached refusal would still say no.
    await writeFile(join(root, "bridge.mjs"), "x");
    await expect(verifyRuntime(root, wanted)).resolves.toMatchObject({
      ok: true,
      cached: false,
    });
  });

  it("refuses a verification whose tree was replaced under it, and caches nothing", async () => {
    // An install activates a new pack while a verification is already reading
    // the old one. That read must not become the cached truth: its bytes are
    // gone, and answering `ok` for them would admit a runtime that is no
    // longer on disk.
    clearRuntimeVerificationCache();
    const root = await writeBundle("replaced-under-us", { "bridge.mjs": "x" });
    const digest = await computeTreeDigest(root);
    clearRuntimeVerificationCache();

    const inFlight = verifyRuntime(root, digest);
    // Exactly what `installRuntimePack` does at activation, while the read
    // above is still walking the tree.
    clearRuntimeVerificationCache();
    await expect(inFlight).resolves.toMatchObject({
      ok: false,
      reason: "unreadable",
    });

    // Nothing stale was published: the next caller does the work itself.
    await expect(verifyRuntime(root, digest)).resolves.toMatchObject({
      ok: true,
      cached: false,
    });
  });

  it("keys the cache on the expected digest, so an upgrade re-verifies", async () => {
    // A pack activated into the same path with a new expected digest is a
    // different runtime. A cache keyed on the path alone would answer for it.
    clearRuntimeVerificationCache();
    const root = await writeBundle("rekey", { "bridge.mjs": "v1" });
    await verifyRuntime(root, await computeTreeDigest(root));
    await writeFile(join(root, "bridge.mjs"), "v2");
    const upgraded = await verifyRuntime(root, await computeTreeDigest(root));
    expect(upgraded).toMatchObject({ ok: true, cached: false });
  });

  it("never caches a tree that failed to match", async () => {
    clearRuntimeVerificationCache();
    const root = await writeBundle("nocache", { "bridge.mjs": "x" });
    const wrong = `sha256:${"1".repeat(64)}`;
    expect(await verifyRuntime(root, wrong)).toMatchObject({
      ok: false,
      reason: "digest-mismatch",
    });
    expect(await verifyRuntime(root, wrong)).toMatchObject({
      ok: false,
      reason: "digest-mismatch",
    });
  });

  it("re-verifies from the stat snapshot, and notices an added file", async () => {
    clearRuntimeVerificationCache();
    const root = await writeBundle("added", { "bridge.mjs": "x" });
    const resolved = await resolveManagedBundle({
      manifest: manifestFor("added", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await expect(revalidateRuntime(resolved.runtime)).resolves.toEqual({
      ok: true,
    });

    await writeFile(join(root, "extra.js"), "surprise");
    const result = await revalidateRuntime(resolved.runtime);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(
      /unexpected file appeared/,
    );
  });

  it("notices a file that went missing", async () => {
    clearRuntimeVerificationCache();
    const root = await writeBundle("missingfile", {
      "bridge.mjs": "x",
      "lib/keep.js": "y",
    });
    const resolved = await resolveManagedBundle({
      manifest: manifestFor("missingfile", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    if (!resolved.ok) throw new Error("fixture did not resolve");
    await rm(join(root, "lib/keep.js"));
    const result = await revalidateRuntime(resolved.runtime);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/went missing/);
  });

  it("re-hashes the scripts that constrain the bridge, catching a same-shape rewrite", async () => {
    // The one case a stat compare is weakest against: a rewrite that restores
    // size, mtime and inode. `launcher.mjs` is what forces the bridge listener
    // onto loopback, so it is re-hashed on every pre-spawn re-verify whatever
    // the snapshot says — it costs about a millisecond.
    clearRuntimeVerificationCache();
    const root = await writeBundle("rewrite", { "bridge.mjs": "x" });
    const resolved = await resolveManagedBundle({
      manifest: manifestFor("rewrite", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    if (!resolved.ok) throw new Error("fixture did not resolve");

    const launcher = join(root, "launcher.mjs");
    const before = await stat(launcher);
    const original = await readFile(launcher);
    await writeFile(launcher, Buffer.alloc(original.length, 0x7a));
    // Restore both halves of the cheap identity so only the hash can tell.
    await utimes(launcher, before.atime, before.mtime);

    const result = await revalidateRuntime(resolved.runtime);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(
      /rewritten in place|was modified/,
    );
  });

  it("catches an in-place rewrite of a large binary from the stat compare alone", async () => {
    // The field that makes this work is `ctime`. A tamper can restore size,
    // mode and mtime — `utimes` takes any value — but nothing in userland sets
    // ctime, and the write that changed the bytes moved it. So `bin/node`, the
    // one file the cheap path does NOT re-hash by default, is still caught.
    //
    // That is why the default is cheap rather than weak: re-hashing the large
    // binaries (see `MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY`) defends the
    // narrower case where the stat fields themselves cannot be trusted.
    delete process.env.MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY;
    clearRuntimeVerificationCache();
    const root = await writeBundle("bignode", { "bridge.mjs": "x" });
    const nodePath = join(root, "bin", "node");
    const stamp = new Date(1_600_000_000_000);
    await utimes(nodePath, stamp, stamp);

    const resolved = await resolveManagedBundle({
      manifest: manifestFor("bignode", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    if (!resolved.ok) throw new Error("fixture did not resolve");
    await expect(revalidateRuntime(resolved.runtime)).resolves.toEqual({
      ok: true,
    });

    // Rewritten in place: same length, same inode, same mode, mtime put back.
    const original = await readFile(nodePath);
    await writeFile(nodePath, Buffer.alloc(original.length, 0x7a));
    await utimes(nodePath, stamp, stamp);
    const after = await stat(nodePath);
    expect(after.mtimeMs).toBe(stamp.getTime());
    // …and the field that gives it away.
    expect(after.ctimeMs).toBeGreaterThan(stamp.getTime());

    const result = await revalidateRuntime(resolved.runtime);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(
      /changed after consent was granted/,
    );
  });

  it("re-hashes the large binaries too when strict re-verification is on", async () => {
    // The knob's own effect, isolated from the stat compare: with the snapshot
    // agreeing on every field, only a re-read can disagree. Achieved by
    // re-baselining the snapshot AFTER the rewrite, which is the only way a
    // test can simulate stat fields a tamper could forge.
    clearRuntimeVerificationCache();
    const root = await writeBundle("strictnode", { "bridge.mjs": "x" });
    const resolved = await resolveManagedBundle({
      manifest: manifestFor("strictnode", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    if (!resolved.ok) throw new Error("fixture did not resolve");

    const verification = await verifyRuntime(root, resolved.runtime.digest);
    if (!verification.ok) throw new Error("fixture did not verify");
    const nodePath = join(root, "bin", "node");
    const original = await readFile(nodePath);
    await writeFile(nodePath, Buffer.alloc(original.length, 0x7a));
    // Re-stamp the snapshot from the tampered file, so every cheap field
    // agrees and only the recorded content digest still describes the
    // original bytes.
    const rewritten = await stat(nodePath);
    const entry = verification.snapshot.entries.find(
      (e) => e.path === "bin/node",
    )!;
    Object.assign(entry, {
      size: rewritten.size,
      mtimeMs: rewritten.mtimeMs,
      ctimeMs: rewritten.ctimeMs,
      ino: Number(rewritten.ino),
      mode: rewritten.mode,
    });

    try {
      process.env.MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY = "true";
      const strict = await revalidateRuntime(resolved.runtime);
      expect(strict.ok).toBe(false);
      expect((strict as { message: string }).message).toMatch(
        /rewritten in place/,
      );
    } finally {
      delete process.env.MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY;
    }
  });

  it("baselines the strict files even with the knob off, so turning it on works", async () => {
    // The trap this avoids: recording a content digest only in strict mode
    // would leave the first strict re-verify with nothing to compare against,
    // and it would have to either refuse a healthy tree or silently skip the
    // very file it was turned on for.
    delete process.env.MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY;
    clearRuntimeVerificationCache();
    const root = await writeBundle("baseline", { "bridge.mjs": "x" });
    const verification = await verifyRuntime(
      root,
      await computeTreeDigest(root),
    );
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(Object.keys(verification.snapshot.executableDigests)).toEqual(
      expect.arrayContaining(["bin/node", "launcher.mjs", "bridge.mjs"]),
    );
  });
});

describe("re-verification immediately before spawn", () => {
  it("catches a bundle replaced after consent was granted", async () => {
    const root = await writeBundle("swap", { "bridge.mjs": "trusted" });
    const resolved = await resolveManagedBundle({
      manifest: manifestFor("swap", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await expect(revalidateRuntime(resolved.runtime)).resolves.toEqual({
      ok: true,
    });

    await writeFile(join(root, "bridge.mjs"), "swapped");
    const result = await revalidateRuntime(resolved.runtime);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(
      /after consent was granted/,
    );
  });
});

/**
 * `resolveSystemInstall` rejects a non-root-owned executable before it reaches
 * provenance, identity, or version checks — deliberately, since the session
 * user could otherwise rewrite it between the probe and the launch. That makes
 * every test that PLANTS a fixture root-only: as an ordinary user the files
 * under a `mkdtemp` directory are rejected on ownership first, and the
 * assertions would be measuring the wrong refusal. Cases that never reach the
 * ownership check live in the unskipped describe below instead, so an ordinary
 * CI run does not silently lose them.
 */
describe.skipIf(process.getuid?.() !== 0)("system installations", () => {
  const systemManifest: LocalHarnessCompatibility = {
    ...LOCAL_HARNESS_MANIFEST["claude-code"],
    runtime: {
      source: "system-install",
      executableNames: ["claude"],
      executableVersionRange: ">=1.0.0",
      vendorIdentityPolicy: {
        probeArgs: ["--version"],
        stdoutPattern: "^claude \\d+\\.\\d+",
        requirePlatformProvenance: false,
      },
    },
  };

  async function installAt(dir: string, mode = 0o755) {
    await mkdir(dir, { recursive: true });
    const exe = join(dir, "claude");
    await writeFile(exe, "#!/bin/sh\necho 'claude 1.2.3'\n", { mode });
    await chmod(exe, mode);
    return exe;
  }

  it("accepts a system-owned executable that identifies itself", async () => {
    const dir = join(base, "usr-local-bin");
    const exe = await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtime.launcherPath).toBe(exe);
    expect(result.runtime.vendorVersionLine).toBe("claude 1.2.3");
  });

  it("rejects an installation the session or workspace could write", async () => {
    const dir = join(base, "workspace", "node_modules", ".bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [join(base, "workspace")],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-untrusted-path" });
  });

  it("rejects an executable owned by the session user rather than a system owner", async () => {
    // Mode alone is not enough: the owner can chmod it back. The agent we
    // are about to start runs as that user.
    const { chown } = await import("node:fs/promises");
    const dir = join(base, "user-owned-bin");
    const exe = await installAt(dir);
    await chown(exe, 65534, 65534); // nobody
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-untrusted-path" });
    expect((result as { message: string }).message).toMatch(
      /rather than a system owner/,
    );
  });

  it("rejects a root-owned executable under a writable parent directory", async () => {
    // Unlink and rename are authorized by the DIRECTORY's permissions, not the
    // file's. A root-owned, mode-0755 binary in a user-writable directory can
    // be moved aside and replaced wholesale — its own uid and mode say nothing
    // about that, because a new file simply takes its name.
    const dir = join(base, "loose-parent", "bin");
    await installAt(dir);
    await chmod(join(base, "loose-parent"), 0o777);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-untrusted-path" });
    expect((result as { message: string }).message).toMatch(
      /writable by a non-system owner/,
    );
  });

  it("rejects an executable under a parent owned by the session user", async () => {
    const { chown } = await import("node:fs/promises");
    const dir = join(base, "user-parent", "bin");
    await installAt(dir);
    await chown(join(base, "user-parent"), 65534, 65534); // nobody
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-untrusted-path" });
  });

  it("accepts a sticky world-writable ancestor, which /tmp relies on", async () => {
    // Sticky is not a loophole: on a sticky directory only a file's owner may
    // unlink or rename it, which is the exact property being checked. Without
    // the exemption every installation below /tmp would be refused for a risk
    // the sticky bit already removes.
    const dir = join(base, "sticky-parent", "bin");
    await installAt(dir);
    await chmod(join(base, "sticky-parent"), 0o1777);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a world-writable executable, which cannot be held between probe and launch", async () => {
    const dir = join(base, "loose-bin");
    await installAt(dir, 0o777);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/world-writable/);
  });

  it("rejects an executable that does not identify itself as the vendor's", async () => {
    const dir = join(base, "impostor-bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "not-claude 9\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(
      /did not identify itself/,
    );
  });

  it("refuses to guess between two acceptable installations", async () => {
    const a = join(base, "bin-a");
    const b = join(base, "bin-b");
    await installAt(a);
    await installAt(b);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [a, b],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-ambiguous" });
  });

  it("fails closed when the manifest requires provenance we cannot verify", async () => {
    // The field is a promise the manifest makes. With no code-signature
    // verifier, honouring it means refusing — not accepting an executable on
    // the strength of its own --version output.
    const dir = join(base, "provenance-bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: {
        ...systemManifest,
        runtime: {
          ...systemManifest.runtime,
          vendorIdentityPolicy: {
            probeArgs: ["--version"],
            stdoutPattern: "^claude \\d+\\.\\d+",
            requirePlatformProvenance: true,
          },
        },
      } as LocalHarnessCompatibility,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({
      status: "system-runtime-identity-mismatch",
    });
    expect((result as { message: string }).message).toMatch(/provenance/);
  });

  it("enforces the manifest's version range, not just the identity pattern", async () => {
    const dir = join(base, "old-bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: {
        ...systemManifest,
        runtime: {
          ...systemManifest.runtime,
          executableVersionRange: ">=2.0.0",
        },
      } as LocalHarnessCompatibility,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({
      status: "system-runtime-identity-mismatch",
    });
    expect((result as { message: string }).message).toMatch(
      /outside the manifest range/,
    );
  });

  it("reports the rejection that actually happened, not a blanket one", async () => {
    const dir = join(base, "wrong-identity-bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "not-claude 9\n", exitCode: 0 }),
    });
    // A failed identity probe is not "the session can write this path".
    expect(result).toMatchObject({
      status: "system-runtime-identity-mismatch",
    });
  });

  it("catches a system executable replaced after consent was granted", async () => {
    // The other half of `revalidateRuntime`. The managed-bundle branch is
    // covered above; this is the one that notices a binary swapped after the
    // user clicked Allow.
    const dir = join(base, "revalidate-bin");
    const exe = await installAt(dir);
    const resolved = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await expect(revalidateRuntime(resolved.runtime)).resolves.toEqual({
      ok: true,
    });

    await writeFile(exe, "#!/bin/sh\necho 'swapped'\n", { mode: 0o755 });
    const result = await revalidateRuntime(resolved.runtime);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toMatch(/was replaced/);
  });

  it("refuses a manifest range outside the grammar it can evaluate", async () => {
    const dir = join(base, "range-bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: {
        ...systemManifest,
        runtime: {
          ...systemManifest.runtime,
          executableVersionRange: "^1.0.0",
        },
      } as LocalHarnessCompatibility,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({
      status: "system-runtime-identity-mismatch",
    });
    expect((result as { message: string }).message).toMatch(
      /not one of the shapes/,
    );
  });

  it("does not let a prerelease satisfy a stable minimum", async () => {
    const dir = join(base, "prerelease-bin");
    await installAt(dir);
    const result = await resolveSystemInstall({
      manifest: systemManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [dir],
      probe: async () => ({ stdout: "claude 2.0.0-beta.1\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({
      status: "system-runtime-identity-mismatch",
    });
  });
});

describe("system install search paths", () => {
  it("searches only system-owned locations by default", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const path of systemInstallSearchPaths(platform)) {
        expect(
          path.startsWith("/usr/") ||
            path.startsWith("/opt/") ||
            path.startsWith("/bin"),
        ).toBe(true);
      }
    }
  });
});

describe("system installs on macOS", () => {
  it("refuses outright, because the ancestor check is blind to darwin ACLs", async () => {
    // NFSv4-style ACLs grant rights such as `delete_child` without appearing
    // in `st_mode`, and Node cannot read them — so the ancestor-trust check is
    // KNOWN to be blind there. A discovery that cannot make its own guarantee
    // refuses rather than reporting a trust it did not establish. (Linux is
    // fine: a POSIX ACL's mask lands in the group bits, so the same check
    // does see those.)
    const darwinManifest: LocalHarnessCompatibility = {
      ...LOCAL_HARNESS_MANIFEST["claude-code"],
      runtime: {
        source: "system-install",
        executableNames: ["claude"],
        executableVersionRange: ">=1.0.0",
        vendorIdentityPolicy: {
          probeArgs: ["--version"],
          stdoutPattern: "^claude \\d+\\.\\d+",
          requirePlatformProvenance: false,
        },
      },
    };
    const result = await resolveSystemInstall({
      manifest: darwinManifest,
      platform: "darwin",
      forbiddenRoots: [],
      searchPaths: ["/usr/local/bin"],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({
      ok: false,
      status: "system-runtime-untrusted-path",
    });
    expect((result as { message: string }).message).toMatch(/macOS/);
  });
});

describe("system install discovery without a candidate", () => {
  // Runs as any user: an empty search path returns before `resolveSystemInstall`
  // looks at ownership at all, so this case needs none of the root-only setup.
  const searchManifest: LocalHarnessCompatibility = {
    ...LOCAL_HARNESS_MANIFEST["claude-code"],
    runtime: {
      source: "system-install",
      executableNames: ["claude"],
      executableVersionRange: ">=1.0.0",
      vendorIdentityPolicy: {
        probeArgs: ["--version"],
        stdoutPattern: "^claude \\d+\\.\\d+",
        requirePlatformProvenance: false,
      },
    },
  };

  it("reports nothing installed when nothing is there", async () => {
    const result = await resolveSystemInstall({
      manifest: searchManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [join(base, "empty-bin")],
      probe: async () => ({ stdout: "", exitCode: 1 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-not-installed" });
  });

  it("reports nothing installed when no search path is given at all", async () => {
    const result = await resolveSystemInstall({
      manifest: searchManifest,
      platform: "linux",
      forbiddenRoots: [],
      searchPaths: [],
      probe: async () => ({ stdout: "claude 1.2.3\n", exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "system-runtime-not-installed" });
  });
});
