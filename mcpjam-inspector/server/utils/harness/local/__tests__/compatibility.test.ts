import { describe, expect, it } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import claudeAdapterPkg from "@ai-sdk/harness-claude-code/package.json" with { type: "json" };
import { createCodexAppServer } from "../../codex-appserver/index.js";
import {
  CODEX_BRIDGE_BUNDLE_DIGEST,
  CODEX_LOCAL_ADAPTER_IDENTITY,
} from "../../codex-appserver/local-identity.js";
import {
  LOCAL_HARNESS_MANIFEST,
  resolveLocalCompatibility,
  type LocalHarnessCompatibility,
  localPermissionModeFor,
  localSandboxPolicyFor,
} from "../compatibility.js";
import { LOCAL_UNATTENDED_SANDBOX_POLICY } from "../../codex-appserver/shared/sandbox-policy.js";
import {
  LOCAL_PERMISSION_PROFILES,
  SUPPORTED_LOCAL_HARNESS_IDS,
} from "../targets.js";
import { EXPECTED_PACK_VERSIONS, PACK_RECORDS } from "../pack-digests.generated.js";

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
  // Before a release this said "enables nothing"; what must hold either side
  // of one is that conformance is recorded only for a harness whose reviewed
  // pack covers every target it advertises, and that a harness without it
  // still enables nothing.
  it("records conformance only where a reviewed pack covers every advertised target", () => {
    const allTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const;
    for (const harnessId of ["claude-code", "codex"] as const) {
      const manifest = LOCAL_HARNESS_MANIFEST[harnessId];
      if (manifest.lifecycleConformanceVersion === "") {
        const result = resolveLocalCompatibility({
          harnessId,
          platform: "linux",
          targetKind: "local-native",
          installedAdapterVersion: manifest.adapterVersion,
          permissionProfile: "workspace-edits",
        });
        expect(result).toMatchObject({ ok: false, status: "conformance-missing" });
        continue;
      }
      const advertised =
        manifest.nativeTargets ??
        allTargets.filter((target) =>
          manifest.nativePlatforms.includes(target.split("-")[0] as never),
        );
      expect(advertised.length).toBeGreaterThan(0);
      expect(EXPECTED_PACK_VERSIONS[harnessId]).not.toBe("");
      for (const target of advertised) {
        expect(PACK_RECORDS[harnessId]?.[target]?.packVersion).toBe(
          EXPECTED_PACK_VERSIONS[harnessId],
        );
      }
    }
  });

  it("names no runtime it cannot verify, whether or not a pack has been built", () => {
    // Pack digests are per TARGET (`<os>-<arch>`) and written by the pack
    // build. Written this way rather than "the map is empty" so it keeps
    // meaning something after a release fills it: what must hold is that every
    // digest present is a real one. An absent target answers `bundle-absent` —
    // the same honest answer a missing directory gets — instead of launching
    // an unverified runtime.
    // Claude Code's bridge is the adapter's own (byte-compared at session
    // start); Codex's is MCPJam's bundle, whose digest the release gate
    // compares against the published pack's manifest.
    expect(LOCAL_HARNESS_MANIFEST["claude-code"].bridgeBundleDigest).toBe(
      `sha256:${"0".repeat(64)}`,
    );
    expect(LOCAL_HARNESS_MANIFEST.codex.bridgeBundleDigest).toBe(
      CODEX_BRIDGE_BUNDLE_DIGEST,
    );
    expect(CODEX_BRIDGE_BUNDLE_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const manifest of Object.values(LOCAL_HARNESS_MANIFEST)) {
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
    // Codex is MCPJam's app-server adapter.
    expect(LOCAL_HARNESS_MANIFEST.codex.supportsBuiltinToolApprovals).toBe(
      createCodexAppServer().supportsBuiltinToolApprovals,
    );
    expect(createCodexAppServer().supportsBuiltinToolApprovals).toBe(true);
  });

  it("pins the exact adapter versions the evidence was gathered against", () => {
    // The pin that caught the canary-to-stable move: the manifest was reviewed
    // against `1.0.0-canary.9`, the repo moved to the stable line, and this
    // assertion is what said so rather than the translator failing at runtime.
    expect(LOCAL_HARNESS_MANIFEST["claude-code"].adapterVersion).toBe(
      claudeAdapterPkg.version,
    );
    // Codex's local adapter is the app-server bridge bundle plus the exact
    // CLI; the pack byte-compare is what enforces it.
    expect(LOCAL_HARNESS_MANIFEST.codex.adapterVersion).toBe(
      CODEX_LOCAL_ADAPTER_IDENTITY,
    );
    expect(CODEX_LOCAL_ADAPTER_IDENTITY).toMatch(
      /^app-server\/[0-9a-f]{32}\+@openai\/codex@\d+\.\d+\.\d+$/,
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
      ".harness-bootstrap/codex-appserver",
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

  it("maps unrestricted execution for trusted unattended schedulers", () => {
    expect(
      LOCAL_HARNESS_MANIFEST["claude-code"].permissionProfileMapping,
    ).toHaveProperty("unrestricted", "allow-all");
  });
});

describe("codex runs locally only on the app-server adapter, attended, where certified", () => {
  const codex = (overrides: Partial<LocalHarnessCompatibility> = {}) =>
    conformed(LOCAL_HARNESS_MANIFEST.codex, overrides);

  it("maps the attended profiles to approval modes and unrestricted to allow-all inside the sandbox", () => {
    expect(LOCAL_HARNESS_MANIFEST.codex.permissionProfileMapping).toEqual({
      "read-only": "allow-reads",
      "workspace-edits": "allow-edits",
      unrestricted: "allow-all",
    });
    // allow-all is only ever paired with the explicit D2 policy.
    expect(LOCAL_HARNESS_MANIFEST.codex.unattendedSandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    });
  });

  it("maps attended profiles onto approval-gated modes on a certified target", () => {
    for (const [profile, mode] of [
      ["read-only", "allow-reads"],
      ["workspace-edits", "allow-edits"],
    ] as const) {
      expect(
        resolveLocalCompatibility(
          {
            harnessId: "codex",
            platform: "linux",
            targetKind: "local-native",
            packTarget: "linux-x64",
            installedAdapterVersion: PINNED_CODEX,
            permissionProfile: profile,
          },
          codex(),
        ),
      ).toMatchObject({ ok: true, permissionMode: mode });
    }
  });

  it("refuses an architecture its evidence does not cover, even on a listed OS (D8)", () => {
    const result = resolveLocalCompatibility(
      {
        harnessId: "codex",
        platform: "linux",
        targetKind: "local-native",
        packTarget: "linux-arm64",
        installedAdapterVersion: PINNED_CODEX,
        permissionProfile: "workspace-edits",
      },
      codex(),
    );
    expect(result).toMatchObject({ status: "native-not-eligible" });
    expect((result as { message: string }).message).toMatch(/certified/);
  });

  it("refuses Windows until its sandbox setup has evidence", () => {
    expect(LOCAL_HARNESS_MANIFEST.codex.nativePlatforms).not.toContain("win32");
  });

  const unattended = (
    overrides: Partial<Parameters<typeof resolveLocalCompatibility>[0]> = {},
    manifest: Partial<LocalHarnessCompatibility> = {},
  ) =>
    resolveLocalCompatibility(
      {
        scope: "unattended",
        harnessId: "codex",
        platform: "linux",
        targetKind: "local-native",
        packTarget: "linux-x64",
        installedAdapterVersion: PINNED_CODEX,
        permissionProfile: "unrestricted",
        ...overrides,
      },
      codex(manifest),
    );

  it("refuses unattended runs on a target whose sandbox was never measured", () => {
    // As shipped: no target has passed, so unattended local Codex is refused
    // everywhere — never run without the sandbox.
    const refused = unattended();
    expect(refused).toMatchObject({ ok: false, status: "backend-not-verified" });
    expect((refused as { message: string }).message).toMatch(/sandbox/);
    expect(
      unattended({}, { unattendedSandboxTargets: ["darwin-arm64"] }),
    ).toMatchObject({ ok: false, status: "backend-not-verified" });
  });

  it("admits unattended allow-all on a target whose sandbox was measured", () => {
    expect(
      unattended({}, { unattendedSandboxTargets: ["linux-x64"] }),
    ).toMatchObject({ ok: true, permissionMode: "allow-all" });
  });

  it("refuses an unattended caller that cannot state its target", () => {
    expect(
      unattended(
        { packTarget: undefined },
        { unattendedSandboxTargets: ["linux-x64"] },
      ),
    ).toMatchObject({ ok: false, status: "backend-not-verified" });
    // No pack target at all is already refused by the D8 certification gate.
    expect(
      unattended({ packTarget: null }, { unattendedSandboxTargets: ["linux-x64"] }),
    ).toMatchObject({ ok: false });
  });

  it("never admits unrestricted to the Playground, sandbox or not", () => {
    expect(
      unattended(
        { scope: "attended" },
        { unattendedSandboxTargets: ["linux-x64"] },
      ),
    ).toMatchObject({ ok: false, status: "permission-profile-not-supported" });
    expect(
      localPermissionModeFor("codex", "unrestricted", "local-native", "attended"),
    ).toBeNull();
    expect(
      localPermissionModeFor("codex", "unrestricted", "local-native", "unattended"),
    ).toBe("allow-all");
  });

  it("hands the explicit policy only to an unattended unrestricted native turn", () => {
    expect(
      localSandboxPolicyFor("codex", "unrestricted", "local-native", "unattended"),
    ).toBe(LOCAL_UNATTENDED_SANDBOX_POLICY);
    for (const [harnessId, profile, kind, scope] of [
      ["codex", "unrestricted", "local-native", "attended"],
      ["codex", "workspace-edits", "local-native", "unattended"],
      ["codex", "unrestricted", "local-isolated", "unattended"],
      ["claude-code", "unrestricted", "local-native", "unattended"],
      ["toString", "unrestricted", "local-native", "unattended"],
    ] as const)
      expect(localSandboxPolicyFor(harnessId, profile, kind, scope)).toBeNull();
  });

  it("records no target as passing the unattended sandbox yet", () => {
    expect(LOCAL_HARNESS_MANIFEST.codex.unattendedSandboxTargets).toEqual([]);
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

  it("offers Windows native, where the Job Object launcher is the tree guarantee", () => {
    // Eligibility only. Whether a given machine may actually run a session is
    // still gated by `supportsOwnershipProof('win32')`, which stays false
    // until runtime resolution has verified the launcher inside the pack —
    // see `process-identity.test.ts` and `availability.test.ts`.
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
    ).toMatchObject({ ok: true, permissionMode: "allow-edits" });
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
