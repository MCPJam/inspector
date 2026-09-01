import { describe, expect, it } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import claudeAdapterPkg from "@ai-sdk/harness-claude-code/package.json" with { type: "json" };
import codexAdapterPkg from "@ai-sdk/harness-codex/package.json" with { type: "json" };
import {
  LOCAL_HARNESS_MANIFEST,
  resolveLocalCompatibility,
  type LocalHarnessCompatibility,
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

  it("ships placeholder digests that cannot match a real tree", () => {
    // A real bundle can never hash to all zeroes, so an install that somehow
    // shipped without the CI-recorded digest fails verification instead of
    // launching an unverified runtime.
    for (const manifest of Object.values(LOCAL_HARNESS_MANIFEST)) {
      expect(manifest.bridgeBundleDigest).toBe(`sha256:${"0".repeat(64)}`);
      // The one `resolveManagedBundle` actually compares a real tree against,
      // so it is the one that keeps an unverified runtime from launching.
      expect(manifest.runtime).toMatchObject({
        source: "managed-bundle",
        bundleDigest: `sha256:${"0".repeat(64)}`,
      });
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
