import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
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
  computeTreeDigest,
  resolveManagedBundle,
  resolveSystemInstall,
  revalidateRuntime,
  systemInstallSearchPaths,
} from "../runtime-identity.js";

let base: string;
let runtimeRoot: string;

async function writeBundle(name: string, files: Record<string, string>) {
  const root = join(runtimeRoot, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
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
      bundleDigest: digest,
      launcherRelativePath: "bridge.mjs",
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
    expect(result.runtime.launcherPath).toBe(join(root, "bridge.mjs"));
    expect(result.runtime.digest).toBe(digest);
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

  it("rejects the all-zero placeholder digest the repo ships", async () => {
    // The shipped manifest cannot enable a runtime by accident, even if a
    // bundle directory somehow exists.
    await writeBundle("claude-code", { "bridge.mjs": "x" });
    const result = await resolveManagedBundle({
      manifest: LOCAL_HARNESS_MANIFEST["claude-code"],
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({
      ok: false,
      status: "bundle-digest-mismatch",
    });
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
    const root = await writeBundle("nolauncher", { "lib/x.js": "x" });
    const result = await resolveManagedBundle({
      manifest: manifestFor("nolauncher", await computeTreeDigest(root)),
      runtimeRoot,
      platform: "linux",
    });
    expect(result).toMatchObject({ ok: false, status: "bundle-corrupt" });
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
