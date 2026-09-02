import { describe, expect, it } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import claudeAdapterPkg from "@ai-sdk/harness-claude-code/package.json" with { type: "json" };
import codexAdapterPkg from "@ai-sdk/harness-codex/package.json" with { type: "json" };
import {
  LOCAL_HARNESS_MANIFEST,
  resolveLocalCompatibility,
  type LocalHarnessCompatibility,
  localPermissionModeFor,
} from "../compatibility.js";
import {
  LOCAL_PERMISSION_PROFILES,
  SUPPORTED_LOCAL_HARNESS_IDS,
} from "../targets.js";

/** The version each manifest was reviewed against. Supplied on every query
 *  because the pin is mandatory — a caller that cannot state the installed
 *  version does not get to skip it — and it differs per adapter, so it is read
 *  from the manifest rather than hardcoded once. */
const PINNED = LOCAL_HARNESS_MANIFEST["claude-code"].adapterVersion;
const PINNED_CODEX = LOCAL_HARNESS_MANIFEST.codex.adapterVersion;

/** A manifest with conformance recorded, so the platform/profile rules can be
 *  exercised on their own. Everything shipped has an EMPTY conformance version
 *  until evidence exists, which the first test below is about. */
function conformed(
  base: LocalHarnessCompatibility,
  overrides: Partial<LocalHarnessCompatibility> = {},
): Record<string, LocalHarnessCompatibility> {
  return {
    [base.harnessId]: {
      ...base,
      lifecycleConformanceVersion: "conformance-test",
      ...overrides,
    },
  };
}

describe("the shipped manifest", () => {
  it("enables nothing until conformance evidence is recorded", () => {
    for (const harnessId of ["claude-code", "codex"] as const) {
      const result = resolveLocalCompatibility({
        harnessId,
        platform: "linux",
        targetKind: "local-native",
        installedAdapterVersion:
          LOCAL_HARNESS_MANIFEST[harnessId].adapterVersion,
        permissionProfile: "workspace-edits",
      });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ status: "conformance-missing" });
    }
  });

  it("names no runtime it cannot verify, whether or not a pack has been built", () => {
    // Pack digests are per TARGET (`<os>-<arch>`) and written by the pack
    // build. Written this way rather than "the map is empty" so it keeps
    // meaning something after a release fills it: what must hold is that every
    // digest present is a real one. An absent target answers `bundle-absent` —
    // the same honest answer a missing directory gets — instead of launching
    // an unverified runtime.
    for (const manifest of Object.values(LOCAL_HARNESS_MANIFEST)) {
      expect(manifest.bridgeBundleDigest).toBe(`sha256:${"0".repeat(64)}`);
      expect(manifest.runtime).toMatchObject({ source: "managed-bundle" });
      if (manifest.runtime.source !== "managed-bundle") continue;
      for (const [target, digest] of Object.entries(
        manifest.runtime.bundleDigest,
      )) {
        // The exact five, not a shape: `win32-arm64` matches a regex and is
        // not a target anything builds, so a generated entry naming one would
        // have passed while resolving to a pack that does not exist.
        expect([
          "darwin-arm64",
          "darwin-x64",
          "linux-x64",
          "linux-arm64",
          "win32-x64",
        ]).toContain(target);
        expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(digest).not.toBe(`sha256:${"0".repeat(64)}`);
      }
      // The launcher is the pack's loopback wrapper, never the bridge itself:
      // the bridge stays byte-identical to the pinned adapter's copy so the
      // recipe compare can hold.
      expect(manifest.runtime.launcherRelativePath).toBe("launcher.mjs");
      expect(manifest.runtime.nodeLauncherRelativePath).toBe("bin/node");
    }
  });

  it("mirrors the installed adapters' declared approval capability", () => {
    // The manifest states what the adapter can do; the adapter is the source
    // of truth. A canary bump that flips either value should fail HERE, before
    // it silently changes what native mode is allowed to do.
    expect(
      LOCAL_HARNESS_MANIFEST["claude-code"].supportsBuiltinToolApprovals,
    ).toBe(createClaudeCode().supportsBuiltinToolApprovals);
    expect(LOCAL_HARNESS_MANIFEST.codex.supportsBuiltinToolApprovals).toBe(
      createCodex().supportsBuiltinToolApprovals,
    );
    expect(createCodex().supportsBuiltinToolApprovals).toBe(false);
  });

  it("pins the exact adapter versions the evidence was gathered against", () => {
    // The pin that caught the canary-to-stable move: the manifest was reviewed
    // against `1.0.0-canary.9`, the repo moved to the stable line, and this
    // assertion is what said so rather than the translator failing at runtime.
    expect(LOCAL_HARNESS_MANIFEST["claude-code"].adapterVersion).toBe(
      claudeAdapterPkg.version,
    );
    expect(LOCAL_HARNESS_MANIFEST.codex.adapterVersion).toBe(
      codexAdapterPkg.version,
    );
  });

  it("records the bootstrap directory each adapter actually declares", () => {
    // Relative on the stable line, resolved by the framework against the
    // session's working directory. A stale absolute `/tmp` value here would
    // make the translator match nothing the adapters emit.
    expect(LOCAL_HARNESS_MANIFEST["claude-code"].adapterBootstrapDir).toBe(
      ".harness-bootstrap/claude-code",
    );
    expect(LOCAL_HARNESS_MANIFEST.codex.adapterBootstrapDir).toBe(
      ".harness-bootstrap/codex",
    );
  });

  it("has an entry for every supported harness id, and no others", () => {
    // The type already makes a missing entry a compile error; this catches the
    // runtime half — an id added to the union with a manifest bolted on later.
    expect(Object.keys(LOCAL_HARNESS_MANIFEST).sort()).toEqual(
      [...SUPPORTED_LOCAL_HARNESS_IDS].sort(),
    );
  });

  it("maps every permission profile deliberately, including by omission", () => {
    for (const manifest of Object.values(LOCAL_HARNESS_MANIFEST)) {
      for (const profile of Object.keys(manifest.permissionProfileMapping)) {
        expect(LOCAL_PERMISSION_PROFILES).toContain(profile);
      }
    }
  });

  it("never offers an unrestricted profile for an approval-capable harness", () => {
    expect(
      LOCAL_HARNESS_MANIFEST["claude-code"].permissionProfileMapping,
    ).not.toHaveProperty("unrestricted");
  });
});

describe("codex is structurally barred from native mode", () => {
  it("has no native platform at all", () => {
    expect(LOCAL_HARNESS_MANIFEST.codex.nativePlatforms).toEqual([]);
  });

  it("stays barred even with conformance recorded and on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const result = resolveLocalCompatibility(
        {
          harnessId: "codex",
          platform,
          targetKind: "local-native",
          installedAdapterVersion: PINNED_CODEX,
          permissionProfile: "unrestricted",
        },
        conformed(LOCAL_HARNESS_MANIFEST.codex),
      );
      expect(result).toMatchObject({ status: "native-not-eligible" });
      expect((result as { message: string }).message).toMatch(
        /cannot surface tool approvals/,
      );
    }
  });

  it("offers no local permission profile whatsoever", () => {
    expect(LOCAL_HARNESS_MANIFEST.codex.permissionProfileMapping).toEqual({});
  });
});

describe("claude-code native resolution", () => {
  const manifests = conformed(LOCAL_HARNESS_MANIFEST["claude-code"]);

  it("maps read-only and workspace-edits onto the adapter's approval modes", () => {
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: "darwin",
          targetKind: "local-native",
          installedAdapterVersion: PINNED,
          permissionProfile: "read-only",
        },
        manifests,
      ),
    ).toMatchObject({ ok: true, permissionMode: "allow-reads" });

    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: "linux",
          targetKind: "local-native",
          installedAdapterVersion: PINNED,
          permissionProfile: "workspace-edits",
        },
        manifests,
      ),
    ).toMatchObject({ ok: true, permissionMode: "allow-edits" });
  });

  it("refuses Windows native, where process-tree ownership is unproven", () => {
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: "win32",
          targetKind: "local-native",
          installedAdapterVersion: PINNED,
          permissionProfile: "workspace-edits",
        },
        manifests,
      ),
    ).toMatchObject({ status: "native-not-eligible" });
  });

  it("refuses an unrestricted native turn even if a manifest offered it", () => {
    const permissive = conformed(LOCAL_HARNESS_MANIFEST["claude-code"], {
      permissionProfileMapping: { unrestricted: "allow-all" },
    });
    const result = resolveLocalCompatibility(
      {
        harnessId: "claude-code",
        platform: "linux",
        targetKind: "local-native",
        installedAdapterVersion: PINNED,
        permissionProfile: "unrestricted",
      },
      permissive,
    );
    expect(result).toMatchObject({
      status: "permission-profile-not-supported",
    });
    expect((result as { message: string }).message).toMatch(
      /requires a verified isolation backend/,
    );
  });

  it("refuses an isolated target whose backend has not passed conformance", () => {
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: "linux",
          targetKind: "local-isolated",
          backend: "linux-bwrap",
          installedAdapterVersion: PINNED,
          permissionProfile: "workspace-edits",
        },
        manifests,
      ),
    ).toMatchObject({ status: "backend-not-verified" });
  });

  it("refuses an isolated target that does not name a backend", () => {
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: "linux",
          targetKind: "local-isolated",
          installedAdapterVersion: PINNED,
          permissionProfile: "workspace-edits",
        },
        manifests,
      ),
    ).toMatchObject({ status: "backend-not-verified" });
  });

  it("refuses an adapter version the manifest was not reviewed against", () => {
    const result = resolveLocalCompatibility(
      {
        harnessId: "claude-code",
        platform: "linux",
        targetKind: "local-native",
        installedAdapterVersion: "1.0.0-canary.99",
        permissionProfile: "workspace-edits",
      },
      manifests,
    );
    expect(result).toMatchObject({ status: "adapter-version-mismatch" });
    expect((result as { message: string }).message).toMatch(/command shapes/);
  });

  it("refuses a harness with no manifest entry", () => {
    // `cursor` is a REAL harness id now (it runs hosted), which is exactly why
    // it belongs here: shipping a local adapter is a security-sensitive act, so
    // a harness earns the local lane only with a reviewed manifest and
    // conformance evidence — never by being added to the SDK's HARNESS_IDS.
    // `SupportedLocalHarnessId` stays deliberately narrower for the same reason.
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "cursor",
          platform: "linux",
          targetKind: "local-native",
          installedAdapterVersion: PINNED,
          permissionProfile: "read-only",
        },
        manifests,
      ),
    ).toMatchObject({ status: "harness-not-supported" });
  });

  it.each(["toString", "__proto__", "constructor"])(
    "refuses the inherited Object property %s as a harness id",
    (harnessId) => {
      // An id off the wire must never resolve to an inherited property: the
      // presence check would pass and the resolver would throw instead of
      // returning its named refusal.
      expect(
        resolveLocalCompatibility(
          {
            harnessId,
            platform: "linux",
            targetKind: "local-native",
            installedAdapterVersion: PINNED,
            permissionProfile: "read-only",
          },
          manifests,
        ),
      ).toMatchObject({ status: "harness-not-supported" });
    },
  );

  it("refuses a caller that cannot state the installed adapter version", () => {
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: "linux",
          targetKind: "local-native",
          installedAdapterVersion: undefined,
          permissionProfile: "read-only",
        },
        manifests,
      ),
    ).toMatchObject({ status: "adapter-version-mismatch" });
  });

  it("refuses a platform local execution does not cover", () => {
    expect(
      resolveLocalCompatibility(
        {
          harnessId: "claude-code",
          platform: null,
          targetKind: "local-native",
          installedAdapterVersion: PINNED,
          permissionProfile: "read-only",
        },
        manifests,
      ),
    ).toMatchObject({ status: "platform-not-supported" });
  });
});

// The mode an agent is built with, for a LOCAL turn, comes from here and
// nowhere else. Taking the adapter's default instead meant a user who
// consented to `read-only` got an agent at `allow-all` — the consent sheet's
// central promise, unenforced.
describe("localPermissionModeFor", () => {
  it("maps each offered profile to its narrower mode", () => {
    expect(localPermissionModeFor("claude-code", "read-only", "local-native")).toBe(
      "allow-reads",
    );
    expect(
      localPermissionModeFor("claude-code", "workspace-edits", "local-native"),
    ).toBe("allow-edits");
  });

  it("never resolves `unrestricted` for a native target", () => {
    // Native has no host containment, so this profile has no mode there — and
    // the caller must fail closed rather than fall back to a default.
    expect(
      localPermissionModeFor("claude-code", "unrestricted", "local-native"),
    ).toBeNull();
  });

  it("returns null for a harness with no local mapping", () => {
    expect(
      localPermissionModeFor("not-a-harness", "read-only", "local-native"),
    ).toBeNull();
  });

  it("returns null for inherited Object keys rather than throwing", () => {
    // `toString`, `constructor` and `__proto__` are not `undefined` on a plain
    // object literal, so a bare index would pass a presence check and then
    // throw on `.permissionProfileMapping`. "not-a-harness" above cannot catch
    // that — it is not on the prototype — which is why the first version of
    // this test passed over the hole.
    for (const id of ["toString", "constructor", "__proto__", "valueOf"]) {
      expect(localPermissionModeFor(id, "read-only", "local-native")).toBeNull();
    }
  });

  it("never answers `allow-all` for any profile a native target can consent to", () => {
    // The property that matters, independent of the table's current contents:
    // nothing a user can agree to natively may resolve to the widest mode.
    for (const profile of ["read-only", "workspace-edits", "unrestricted"] as const) {
      expect(
        localPermissionModeFor("claude-code", profile, "local-native"),
      ).not.toBe("allow-all");
    }
  });
});
