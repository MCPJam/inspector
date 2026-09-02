/**
 * The Inspector-owned local compatibility manifest.
 *
 * An adapter cannot self-assert that it is safe to run on a user's machine.
 * What a harness may do locally — which platforms, which permission profiles,
 * whether it is eligible for native mode at all — is declared HERE, in code
 * that is reviewed in this repository, and is checked against the adapter's
 * own declared capabilities at resolution time.
 *
 * Every resolution failure is a named status with an actionable message
 * (invariant 13). "Unsupported" never degrades into "run it anyway with
 * whatever mode the SDK defaults to".
 *
 * ── Why Codex is not native-eligible ──────────────────────────────────────
 * Verified against the pinned packages: `@ai-sdk/harness-codex@1.0.98`
 * declares `supportsBuiltinToolApprovals: false` and rejects every permission
 * mode except `allow-all`, starting Codex unrestricted. That configuration
 * assumes the AI SDK sandbox provider IS the security boundary. A supervised
 * native provider supplies no such boundary, so the same configuration on a
 * host means an unrestricted agent with the OS user's authority and no
 * approval gate. It is therefore hosted / local-isolated only, and the
 * manifest says so structurally rather than in a comment: `nativePlatforms` is
 * empty, so no platform check can accidentally admit it.
 *
 * A staged worktree does not change this. Staging protects review and
 * apply-back semantics; it does not stop a process from reading or writing the
 * rest of the machine.
 */
import type {
  LocalIsolationBackend,
  LocalPackTarget,
  LocalPermissionProfile,
  LocalPlatform,
  SupportedLocalHarnessId,
} from "./targets.js";
import { PACK_TREE_DIGESTS } from "./pack-digests.generated.js";

/** How the vendor runtime is obtained. */
export type LocalHarnessRuntimePolicy =
  | {
      source: "managed-bundle";
      /** Directory name of the bundle inside the Inspector runtime root. */
      bundleName: string;
      /**
       * SHA-256 canonical tree digest of the pack, PER PLATFORM, recorded by
       * the pack build in CI.
       *
       * Per platform because the pack is: it carries a platform-specific Node
       * binary and a platform-specific vendor CLI, so one digest could only
       * ever be right for one of them. A platform with no entry has no pack
       * built for it and resolves `bundle-absent`, which is the same answer a
       * missing directory gives and the correct one.
       */
      bundleDigest: Readonly<Partial<Record<LocalPackTarget, string>>>;
      /** Launcher path relative to the bundle root.
       *
       *  The pack ships `launcher.mjs`, an Inspector-owned wrapper that forces
       *  every listener the bridge opens onto loopback and then imports the
       *  adapter's verbatim `bridge.mjs`. The bridge file itself stays
       *  byte-identical to the adapter's copy — the provider compares it — so
       *  the loopback constraint cannot be applied by patching it. */
      launcherRelativePath: string;
      /** The pack's own Node binary, relative to the bundle root.
       *
       *  Required for BOTH distributions: Electron's `RunAsNode` fuse is off,
       *  and the npx server's `process.execPath` is a Node outside the tree
       *  the digest covers. */
      nodeLauncherRelativePath: string;
      /**
       * Windows only: the Job Object launcher, relative to the pack root.
       *
       * Windows has no process group, so whole-tree cleanup comes from a job
       * with KILL_ON_JOB_CLOSE — and the helper that creates one has to be
       * INSIDE the pack, covered by its tree digest, or the supervisor would be
       * spawning an unverified binary to enforce its own guarantee.
       *
       * Absent on every other platform, where the guarantee is POSIX.
       */
      jobLauncherRelativePath?: string;
      /** Exact vendor packages the bundle is built from, for the audit record
       *  and for the version the UI shows before start. */
      vendorPackages: Readonly<Record<string, string>>;
    }
  | {
      source: "system-install";
      /** Executable basenames to look for, in preference order. */
      executableNames: readonly string[];
      /** Semver range the discovered executable must satisfy. */
      executableVersionRange: string;
      vendorIdentityPolicy: VendorIdentityPolicy;
    };

/**
 * How a SYSTEM executable proves it is the vendor's, beyond its version.
 *
 * `probeArgs` is run with `shell: false`, a short timeout, bounded output and
 * the sanitized environment — it is an identity probe, not a capability. The
 * platform provenance checks are advisory where the OS cannot support them and
 * required where it can; a manifest entry that requires one on a platform that
 * cannot provide it simply has no supported tuple there.
 */
export interface VendorIdentityPolicy {
  /** Arguments for the version/identity probe (e.g. `["--version"]`). */
  probeArgs: readonly string[];
  /** Regex the probe's stdout must match to be accepted. */
  stdoutPattern: string;
  /** Require a valid code signature / package provenance where available. */
  requirePlatformProvenance: boolean;
}

/** Which SDK permission mode an Inspector profile maps to, per harness. A
 *  profile absent from the map is not offered for that harness. */
export type PermissionProfileMapping = Readonly<
  Partial<
    Record<LocalPermissionProfile, "allow-reads" | "allow-edits" | "allow-all">
  >
>;

export interface HarnessArgvPolicy {
  /** Extra flags this harness must always be launched with, if any. */
  requiredFlags: readonly string[];
  /** Flags denied for this harness specifically, on top of the global
   *  capability denylist in `argv-policy.ts`. */
  deniedFlags: readonly string[];
}

export interface LocalHarnessCompatibility {
  harnessId: SupportedLocalHarnessId;
  /** Exact adapter version this evidence was gathered against. A range would
   *  let a patch release change a command shape without re-review. */
  adapterVersion: string;
  runtime: LocalHarnessRuntimePolicy;
  argvPolicy: HarnessArgvPolicy;
  configStrategy: "synthetic-home" | "explicit-config-root";
  /** The adapter's OWN declared approval capability, mirrored here so a
   *  mismatch with the installed package is a test failure rather than a
   *  silent divergence. */
  supportsBuiltinToolApprovals: boolean;
  permissionProfileMapping: PermissionProfileMapping;
  /** Platforms this harness may run NATIVE on. Empty = never native. */
  nativePlatforms: readonly LocalPlatform[];
  /** Isolation backends conformance has passed for this harness, PER
   *  PLATFORM. A backend proven on Linux says nothing about macOS, and a
   *  single flat list would let one platform's evidence admit another's. */
  isolatedBackends: Readonly<
    Partial<Record<LocalPlatform, readonly LocalIsolationBackend[]>>
  >;
  /** Bumped whenever the lifecycle evidence is re-gathered. */
  lifecycleConformanceVersion: string;
  /**
   * The adapter's DECLARED bootstrap directory, relative to the session's
   * default working directory. The framework resolves it against that
   * directory — which for a local session is the user's granted workspace —
   * and the translator remaps every reference onto the verified managed
   * bundle, so a vendor dependency graph never lands in somebody's checkout.
   */
  adapterBootstrapDir: string;
  /**
   * The exact files the pinned adapter's bootstrap recipe writes into that
   * directory, relative to it.
   *
   * A closed list, for the same reason `ADAPTER_COMMAND_SHAPES` is one: the
   * framework applies the recipe by calling `writeTextFile` on the session, so
   * without this the adapter's dependency manifests and bridge source would be
   * written straight into the user's checkout — files that are then never even
   * read, because every reference to them is remapped onto the managed bundle.
   * Each of these is satisfied from the bundle instead; anything else under the
   * bootstrap directory fails the session closed, which is the signal that an
   * adapter upgrade changed its recipe and the manifest needs re-review.
   */
  adapterBootstrapFiles: readonly string[];
  /** SHA-256 of the bridge artifact shipped with Inspector. */
  bridgeBundleDigest: string;
}

/**
 * `null` conformance version = evidence has NOT been gathered. Resolution
 * treats it as expired, so a manifest entry that exists for review purposes
 * cannot enable anything on its own.
 */
export const LOCAL_HARNESS_MANIFEST: Readonly<
  Record<SupportedLocalHarnessId, LocalHarnessCompatibility>
> = {
  "claude-code": {
    harnessId: "claude-code",
    adapterVersion: "1.0.100",
    runtime: {
      source: "managed-bundle",
      bundleName: "claude-code",
      // Generated by the release pack build, and EMPTY until one has run.
      // An empty map has no entry for this machine's `<os>-<arch>`, so
      // `resolveManagedBundle` refuses with `bundle-absent` — "no pack has
      // been built for linux-x64" — before any tree is read. That is the
      // fail-closed default: a target nobody has built for cannot launch,
      // and the message names the pack a user would go looking for rather
      // than reporting a verification that never happened.
      bundleDigest: PACK_TREE_DIGESTS["claude-code"],
      launcherRelativePath: "launcher.mjs",
      nodeLauncherRelativePath: "bin/node",
      jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
      vendorPackages: {
        "@anthropic-ai/claude-code": "pinned-by-adapter-bridge-lockfile",
      },
    },
    argvPolicy: { requiredFlags: [], deniedFlags: [] },
    configStrategy: "synthetic-home",
    supportsBuiltinToolApprovals: true,
    permissionProfileMapping: {
      "read-only": "allow-reads",
      "workspace-edits": "allow-edits",
      // `unrestricted` is deliberately absent: Claude Code CAN surface
      // approvals, so there is no reason to offer a profile that switches them
      // off on a host.
    },
    // Native eligibility is per platform. macOS and Linux have POSIX process
    // groups, which is what whole-tree cleanup is built on.
    //
    // Windows is still absent, and deliberately so even though the Job Object
    // launcher now exists (`tools/mcpjam-job-launcher`, in this package). Two
    // things have to be true before `win32` is added here, and neither is yet:
    //
    //   1. the launcher ships inside the Windows pack, so its bytes are covered
    //      by the tree digest — `supportsOwnershipProof('win32')` answers false
    //      until runtime resolution has verified one;
    //   2. the conformance suite passes on `windows-latest`, which is what
    //      turns "we wrote a Job Object" into evidence that stopping a session
    //      stops everything it started.
    //
    // An unenforced cleanup promise is worse than no Windows support: a user
    // told their session stopped, whose 376 MB agent is still running, has been
    // lied to.
    nativePlatforms: ["darwin", "linux"],
    // Empty until a backend's escape probes actually pass (I6).
    isolatedBackends: {},
    lifecycleConformanceVersion: "",
    adapterBootstrapDir: ".harness-bootstrap/claude-code",
    adapterBootstrapFiles: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "bridge.mjs",
    ],
    bridgeBundleDigest: `sha256:${"0".repeat(64)}`,
  },
  codex: {
    harnessId: "codex",
    adapterVersion: "1.0.98",
    runtime: {
      source: "managed-bundle",
      bundleName: "codex",
      bundleDigest: PACK_TREE_DIGESTS.codex,
      launcherRelativePath: "launcher.mjs",
      nodeLauncherRelativePath: "bin/node",
      vendorPackages: {
        "@openai/codex-sdk": "pinned-by-adapter-bridge-lockfile",
      },
    },
    argvPolicy: { requiredFlags: [], deniedFlags: [] },
    configStrategy: "explicit-config-root",
    supportsBuiltinToolApprovals: false,
    // No mapping at all: the adapter rejects every mode but `allow-all`, and
    // `allow-all` on a host with no outer boundary is the thing this plan
    // exists to prevent. Codex earns a mapping when its adapter gains a
    // reviewed restricted mode, or inside a verified isolation backend.
    permissionProfileMapping: {},
    nativePlatforms: [],
    isolatedBackends: {},
    lifecycleConformanceVersion: "",
    adapterBootstrapDir: ".harness-bootstrap/codex",
    adapterBootstrapFiles: ["package.json", "pnpm-lock.yaml", "bridge.mjs"],
    bridgeBundleDigest: `sha256:${"0".repeat(64)}`,
  },
};

export type LocalCompatibilityStatus =
  | "ok"
  | "harness-not-supported"
  | "platform-not-supported"
  | "native-not-eligible"
  | "backend-not-verified"
  | "permission-profile-not-supported"
  | "conformance-missing"
  | "adapter-version-mismatch";

export type LocalCompatibilityResult =
  | {
      ok: true;
      manifest: LocalHarnessCompatibility;
      permissionMode: "allow-reads" | "allow-edits" | "allow-all";
    }
  | {
      ok: false;
      status: Exclude<LocalCompatibilityStatus, "ok">;
      message: string;
    };

export interface LocalCompatibilityQuery {
  harnessId: string;
  platform: LocalPlatform | null;
  targetKind: "local-native" | "local-isolated";
  permissionProfile: LocalPermissionProfile;
  backend?: LocalIsolationBackend;
  /** The adapter version actually installed, read from the package at call
   *  time so a lockfile drift cannot pass unnoticed. Required: a caller that
   *  cannot state it cannot be allowed to skip the pin. */
  installedAdapterVersion: string | undefined;
}

/**
 * Resolve a harness/platform/target/profile tuple against the manifest.
 *
 * Fail-closed at every step, and each failure names what a user or operator
 * can actually do about it.
 */
export function resolveLocalCompatibility(
  query: LocalCompatibilityQuery,
  // A PARTIAL lookup, not the full record: `query.harnessId` is a plain string
  // off the wire, and "this harness has no manifest entry" is a first-class
  // answer rather than a type error a caller has to cast around.
  manifests: Readonly<
    Partial<Record<string, LocalHarnessCompatibility>>
  > = LOCAL_HARNESS_MANIFEST,
): LocalCompatibilityResult {
  // OWN properties only: a `harnessId` off the wire spelled `toString` or
  // `__proto__` would otherwise resolve to an inherited Object property, pass
  // the presence check below, and throw somewhere further down instead of
  // returning the named refusal this function promises.
  const manifest = Object.prototype.hasOwnProperty.call(
    manifests,
    query.harnessId,
  )
    ? manifests[query.harnessId]
    : undefined;
  if (!manifest) {
    return {
      ok: false,
      status: "harness-not-supported",
      message:
        `${query.harnessId} has no reviewed local compatibility manifest. ` +
        `Run it hosted, or add a manifest entry with conformance evidence.`,
    };
  }

  // REQUIRED, not optional: omitting it would silently skip the exact adapter
  // pin, which is the check that catches a lockfile drift changing the command
  // shapes the translator is built around.
  if (query.installedAdapterVersion !== manifest.adapterVersion) {
    return {
      ok: false,
      status: "adapter-version-mismatch",
      message:
        `${query.harnessId} adapter ` +
        `${query.installedAdapterVersion ?? "(version not supplied)"} is ` +
        `installed but the local manifest was reviewed against ` +
        `${manifest.adapterVersion}. An adapter upgrade can change the command ` +
        `shapes the local provider translates, so it must be re-reviewed ` +
        `before local execution is enabled.`,
    };
  }

  if (manifest.lifecycleConformanceVersion === "") {
    return {
      ok: false,
      status: "conformance-missing",
      message:
        `${query.harnessId} has no recorded lifecycle conformance evidence. ` +
        `Local execution stays disabled until the conformance suite has been ` +
        `run for this harness/runtime/platform/mode tuple and its version is ` +
        `recorded in the manifest.`,
    };
  }

  if (query.platform === null) {
    return {
      ok: false,
      status: "platform-not-supported",
      message:
        `local execution is not supported on this platform. Run the harness ` +
        `hosted instead.`,
    };
  }

  if (query.targetKind === "local-native") {
    if (!manifest.nativePlatforms.includes(query.platform)) {
      const reason =
        manifest.nativePlatforms.length === 0
          ? `${query.harnessId} is not eligible for native mode on any ` +
            `platform: its adapter cannot surface tool approvals, so native ` +
            `execution would give it the OS user's full authority with no ` +
            `approval gate. Use hosted, or a verified isolation backend.`
          : `${query.harnessId} native mode is not supported on ` +
            `${query.platform} (supported: ` +
            `${manifest.nativePlatforms.join(", ")}).`;
      return {
        ok: false,
        status: "native-not-eligible",
        message: reason,
      };
    }
  } else {
    if (query.backend === undefined) {
      return {
        ok: false,
        status: "backend-not-verified",
        message: "an isolated target must name its isolation backend.",
      };
    }
    const verifiedHere = manifest.isolatedBackends[query.platform] ?? [];
    if (!verifiedHere.includes(query.backend)) {
      return {
        ok: false,
        status: "backend-not-verified",
        message:
          `isolation backend ${query.backend} has not passed conformance for ` +
          `${query.harnessId} on ${query.platform}. Isolated mode never falls ` +
          `back to native — run hosted until the backend is verified for this ` +
          `platform.`,
      };
    }
  }

  const permissionMode =
    manifest.permissionProfileMapping[query.permissionProfile];
  if (permissionMode === undefined) {
    const offered = Object.keys(manifest.permissionProfileMapping);
    return {
      ok: false,
      status: "permission-profile-not-supported",
      message:
        `${query.harnessId} does not offer the ${query.permissionProfile} ` +
        `permission profile locally` +
        (offered.length
          ? ` (offered: ${offered.join(", ")}).`
          : `; it has no locally offered profile at all.`),
    };
  }

  // `unrestricted` never runs without an outer boundary, whatever a manifest
  // says. Checked here as well as in the mapping so a future manifest edit
  // cannot re-open it by accident.
  if (
    query.permissionProfile === "unrestricted" &&
    query.targetKind === "local-native"
  ) {
    return {
      ok: false,
      status: "permission-profile-not-supported",
      message:
        `the unrestricted profile requires a verified isolation backend. ` +
        `Native mode has no host containment, so an unrestricted turn there ` +
        `would run with the OS user's full authority.`,
    };
  }

  return { ok: true, manifest, permissionMode };
}
