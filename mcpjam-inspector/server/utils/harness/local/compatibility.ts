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
 * ── Codex: a different adapter, the same rules ────────────────────────────
 * The published `@ai-sdk/harness-codex` drives `codex exec`, declares
 * `supportsBuiltinToolApprovals: false` and refuses every permission mode but
 * `allow-all` — an unrestricted agent with no approval gate, which on a host
 * with no outer boundary is exactly what this module exists to refuse. So the
 * LOCAL Codex entry is MCPJam's own app-server adapter
 * (`codex-appserver/`), whatever transport hosted Codex uses: real approval
 * requests (attended Playground: `allow-reads` / `allow-edits` → Codex
 * `untrusted`), and, for unattended evals and swarms, `allow-all` ONLY inside
 * Codex's own OS command sandbox with an explicit workspace-write policy
 * (`codex-appserver/shared/sandbox-policy.ts`) on targets where that sandbox
 * was measured to hold (`unattendedSandboxTargets`). A target whose probe
 * failed refuses unattended local Codex; it never runs it unrestricted.
 *
 * A staged worktree does not change any of this. Staging protects review and
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
import { conformanceVersionFor } from "./runtime-compat.js";
import {
  CODEX_BRIDGE_BUNDLE_DIGEST,
  CODEX_LOCAL_ADAPTER_IDENTITY,
  PINNED_CODEX_VERSION,
} from "../codex-appserver/local-identity.js";
import {
  LOCAL_UNATTENDED_SANDBOX_POLICY,
  type CodexWorkspaceWriteSandboxPolicy,
} from "../codex-appserver/shared/sandbox-policy.js";

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
      /**
       * Where the bridge launcher and the bridge come from (invariant 1: two
       * trusted sources, never a third).
       *
       *  - `inspector-layer`: from the Inspector distribution itself — written
       *    to a content-addressed, read-only layer and re-hashed against the
       *    digest compiled into this build before every exec
       *    (`inspector-layer.ts`). The pack then carries vendor bytes only.
       *  - `pack`: from inside the verified pack (`launcherRelativePath`), the
       *    layout every pack had before the split.
       */
      launcherSource: "inspector-layer" | "pack";
      /** Launcher path relative to the bundle root, for `launcherSource: "pack"`.
       *
       *  The pack ships `launcher.mjs`, an Inspector-owned wrapper that forces
       *  every listener the bridge opens onto loopback and then imports the
       *  adapter's verbatim `bridge.mjs`. */
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
  /**
   * The exact pack TARGETS (OS + architecture) whose evidence is complete,
   * when narrower than "every architecture of `nativePlatforms`" (D8).
   *
   * A target outside this set is refused natively and is not advertised by
   * the release gate, even when its OS is listed — so one certified
   * architecture can ship while another stays explicitly unavailable.
   * Absent = every target of every native platform.
   */
  nativeTargets?: readonly LocalPackTarget[];
  /**
   * Targets where the harness's own OS command sandbox was measured to hold
   * the unattended policy (D2). Present only for harnesses whose unattended
   * local runs depend on that sandbox (Codex); a target outside it refuses
   * unattended local execution rather than running without the sandbox.
   */
  unattendedSandboxTargets?: readonly LocalPackTarget[];
  /**
   * The command-sandbox policy an unattended (`unrestricted`) local run of
   * this harness starts under (D2). Declared together with
   * `unattendedSandboxTargets`: a harness whose unattended runs depend on its
   * own OS sandbox names the exact policy here, and the turn hands it to the
   * adapter as a separate field — it is never a permission mode.
   */
  unattendedSandboxPolicy?: Readonly<CodexWorkspaceWriteSandboxPolicy>;
  /** Isolation backends conformance has passed for this harness, PER
   *  PLATFORM. A backend proven on Linux says nothing about macOS, and a
   *  single flat list would let one platform's evidence admit another's. */
  isolatedBackends: Readonly<
    Partial<Record<LocalPlatform, readonly LocalIsolationBackend[]>>
  >;
  /** The recorded lifecycle evidence stamp, read from the generated
   *  compatibility record. Empty = no evidence, which refuses every tuple. */
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
    adapterVersion: "1.0.121",
    runtime: {
      source: "managed-bundle",
      bundleName: "claude-code",
      // Generated by the release pack build, and EMPTY until one has run.
      // Either way the result is `bundle-absent` before any tree is read, but
      // WHICH message depends on what is on disk: with no bundle directory —
      // today's state — `resolveManagedBundle` reports the missing bundle
      // first; with a directory present, the empty map has no entry for this
      // machine's `<os>-<arch>` and it names the target instead ("no pack has
      // been built for linux-x64"). Both fail closed; only the second names a
      // pack a user could go looking for.
      bundleDigest: PACK_TREE_DIGESTS["claude-code"],
      // The patched bridge (with the MCP SDK, `zod` and `ws` compiled in) and
      // the launcher are the Inspector layer's. The pack is `bin/node`, the
      // agent SDK with its platform CLI and declared peers, and the Windows
      // job launcher; the launcher resolves the bridge's one external import,
      // the agent SDK, into it.
      launcherSource: "inspector-layer",
      launcherRelativePath: "launcher.mjs",
      nodeLauncherRelativePath: "bin/node",
      jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
      vendorPackages: {
        "@anthropic-ai/claude-agent-sdk": "pinned-by-claude-code-vendor-lockfile",
      },
    },
    argvPolicy: { requiredFlags: [], deniedFlags: [] },
    configStrategy: "synthetic-home",
    supportsBuiltinToolApprovals: true,
    permissionProfileMapping: {
      "read-only": "allow-reads",
      "workspace-edits": "allow-edits",
      unrestricted: "allow-all",
    },
    // Native eligibility is per platform. macOS and Linux have POSIX process
    // groups, which is what whole-tree cleanup is built on there.
    //
    // Windows has no process group; its whole-tree guarantee is a Job Object
    // with KILL_ON_JOB_CLOSE, created by `tools/mcpjam-job-launcher`, which
    // ships INSIDE the Windows pack so its bytes are covered by the tree
    // digest. Listing `win32` here is necessary but not sufficient:
    // `supportsOwnershipProof('win32')` still answers false until runtime
    // resolution has verified that launcher, so a pack without one keeps the
    // platform refused exactly as before.
    //
    // Earned, not asserted: the conformance suite's `windows-latest` leg runs
    // the full scenario and the abort scenario against the real pack and the
    // real vendor CLI, and its survivor scan is what turns "we wrote a Job
    // Object" into evidence that stopping a session stops everything it
    // started. That leg is gating; the day it goes red, this entry is wrong.
    nativePlatforms: ["darwin", "linux", "win32"],
    // Empty until a backend's escape probes actually pass (I6).
    isolatedBackends: {},
    // From the generated record (`runtime-compat.generated.json`), written with
    // the pin that the evidence was gathered against — never typed by hand.
    lifecycleConformanceVersion: conformanceVersionFor("claude-code"),
    adapterBootstrapDir: ".harness-bootstrap/claude-code",
    // A local session's recipe is the Inspector layer's (`pack-bootstrap.ts`):
    // the bridge, compared against the layer's copy. The adapter's install
    // files (`package.json`, the lockfile, `.npmrc`, `pnpm-workspace.yaml`)
    // install a vendor graph in a sandbox; locally the pack already is it, and
    // a recipe naming them fails closed.
    adapterBootstrapFiles: ["bridge.mjs"],
    bridgeBundleDigest: `sha256:${"0".repeat(64)}`,
  },
  codex: {
    harnessId: "codex",
    // MCPJam's app-server adapter, not an npm package: the bridge bundle hash
    // plus the exact CLI (see `codex-appserver/local-identity.ts`). The
    // Inspector layer — compiled in, re-hashed before every exec, part of the
    // launch identity — is what actually enforces it.
    adapterVersion: CODEX_LOCAL_ADAPTER_IDENTITY,
    runtime: {
      source: "managed-bundle",
      bundleName: "codex",
      bundleDigest: PACK_TREE_DIGESTS.codex,
      // The bridge, its host-tools MCP entrypoint and the launcher are the
      // Inspector layer's; the pack is `bin/node`, `@openai/codex` and its
      // platform package (and the Windows job launcher). `ws` is compiled
      // into the layer's bridge, so it is not a vendor package any more.
      launcherSource: "inspector-layer",
      launcherRelativePath: "launcher.mjs",
      nodeLauncherRelativePath: "bin/node",
      jobLauncherRelativePath: "bin/mcpjam-job-launcher.exe",
      vendorPackages: {
        "@openai/codex": PINNED_CODEX_VERSION,
      },
    },
    argvPolicy: { requiredFlags: [], deniedFlags: [] },
    configStrategy: "explicit-config-root",
    // The app-server adapter raises real approval requests.
    supportsBuiltinToolApprovals: true,
    // Attended profiles map to Codex `untrusted` (every command and file
    // change asks). `unrestricted` — unattended evals and swarms only, never
    // the Playground (`localPermissionModeFor` / `resolveLocalCompatibility`)
    // — is `allow-all` ONLY together with `unattendedSandboxPolicy` below, and
    // only on a target in `unattendedSandboxTargets`. The bridge refuses
    // `allow-all` without that policy when supervised locally, so it can
    // never become `danger-full-access` on a user's machine.
    permissionProfileMapping: {
      "read-only": "allow-reads",
      "workspace-edits": "allow-edits",
      unrestricted: "allow-all",
    },
    // Evidence: the 2026-09-30 macOS arm64 product-assembly probe and the
    // linux-x64 app-server probes (`codex-appserver/README.md`). Every other
    // target stays refused until its own evidence lands (D8).
    nativePlatforms: ["darwin", "linux"],
    nativeTargets: ["darwin-arm64", "linux-x64"],
    // No target has passed the unattended sandbox probe on the pinned binary
    // yet, so unattended local Codex is refused everywhere.
    unattendedSandboxTargets: [],
    unattendedSandboxPolicy: LOCAL_UNATTENDED_SANDBOX_POLICY,
    isolatedBackends: {},
    // From the generated record, like Claude Code's: dark until the Codex
    // lifecycle conformance legs pass and the pin records them.
    lifecycleConformanceVersion: conformanceVersionFor("codex"),
    adapterBootstrapDir: ".harness-bootstrap/codex-appserver",
    // A local session's recipe is the Inspector layer's (`pack-bootstrap.ts`),
    // so these are the only files it writes, and each is compared against the
    // layer's copy. The hosted recipe's `package.json` and lockfile install
    // the vendor graph in a sandbox; locally the pack already IS that graph,
    // and a recipe naming them fails closed.
    adapterBootstrapFiles: ["bridge.mjs", "host-tools-mcp.mjs"],
    bridgeBundleDigest: CODEX_BRIDGE_BUNDLE_DIGEST,
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
  scope?: "attended" | "unattended";
  harnessId: string;
  platform: LocalPlatform | null;
  targetKind: "local-native" | "local-isolated";
  permissionProfile: LocalPermissionProfile;
  backend?: LocalIsolationBackend;
  /** This machine's pack target, for a manifest that narrows to exact
   *  targets (`nativeTargets`). `null` = no pack target at all. */
  packTarget?: LocalPackTarget | null;
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
/**
 * The permission mode a CONSENTED profile maps to, for a local target.
 *
 * Exported because the turn path needs this answer BEFORE it can prepare the
 * local turn: the agent's permission mode and the runtime fingerprint are both
 * fixed earlier than that, and taking the adapter's default for a local turn
 * meant a user who consented to `read-only` got an agent built at `allow-all`.
 * The mapping lives in the manifest and this is the one way to read it, so the
 * pre-flight answer and the prepared plan cannot drift apart by construction.
 *
 * `null` when the harness offers no local mapping for the profile — the caller
 * must then fail closed rather than substitute a default, which is the whole
 * point of asking.
 */
export function localPermissionModeFor(
  harnessId: string,
  permissionProfile: LocalPermissionProfile,
  targetKind: "local-native" | "local-isolated",
  scope: "attended" | "unattended" = "attended",
): "allow-reads" | "allow-edits" | "allow-all" | null {
  // OWN properties only, for the same reason `resolveLocalCompatibility` does
  // it below: `toString`, `constructor` or `__proto__` resolve to an inherited
  // Object property, which is not `undefined`, so it would sail past the
  // presence check and throw on `.permissionProfileMapping` — an unhandled
  // TypeError in the path that decides what a local agent is allowed to do,
  // instead of the documented `null`.
  const manifests = LOCAL_HARNESS_MANIFEST as Record<
    string,
    LocalHarnessCompatibility | undefined
  >;
  const manifest = Object.prototype.hasOwnProperty.call(manifests, harnessId)
    ? manifests[harnessId]
    : undefined;
  if (manifest === undefined) return null;
  // Mirrors the refusal in `resolveLocalCompatibility`: `unrestricted` never
  // runs natively whatever a manifest says, so it can never resolve to a mode
  // here either.
  if (permissionProfile === "unrestricted" && targetKind === "local-native" && scope !== "unattended") {
    return null;
  }
  return manifest.permissionProfileMapping[permissionProfile] ?? null;
}

/**
 * The command-sandbox policy a local turn of this harness must start under,
 * or `null` when it runs without one.
 *
 * Non-null only for an UNATTENDED `unrestricted` native turn of a harness
 * whose manifest names `unattendedSandboxPolicy` (Codex). Like
 * `localPermissionModeFor`, this is the turn path's pre-flight answer: the
 * policy is folded into the runtime fingerprint and handed to the adapter
 * before preparation runs, and preparation (`resolveLocalCompatibility`) is
 * what refuses a target the sandbox was never measured on.
 */
export function localSandboxPolicyFor(
  harnessId: string,
  permissionProfile: LocalPermissionProfile,
  targetKind: "local-native" | "local-isolated",
  scope: "attended" | "unattended" = "attended",
): Readonly<CodexWorkspaceWriteSandboxPolicy> | null {
  const manifests = LOCAL_HARNESS_MANIFEST as Record<
    string,
    LocalHarnessCompatibility | undefined
  >;
  const manifest = Object.prototype.hasOwnProperty.call(manifests, harnessId)
    ? manifests[harnessId]
    : undefined;
  if (
    manifest?.unattendedSandboxPolicy === undefined ||
    permissionProfile !== "unrestricted" ||
    targetKind !== "local-native" ||
    scope !== "unattended"
  ) {
    return null;
  }
  return manifest.unattendedSandboxPolicy;
}

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
      // NOT "run the harness hosted instead". A requested-local turn has Send
      // disabled in this state (`localHarnessBlocksSend`), so nothing falls
      // back — and on a local Inspector with no cloud data plane there is no
      // hosted target to switch to either, which makes the instruction
      // unactionable exactly where it is most likely to be read.
      message: `local execution is not supported on this platform.`,
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
    if (
      manifest.nativeTargets !== undefined &&
      query.packTarget !== undefined &&
      (query.packTarget === null ||
        !manifest.nativeTargets.includes(query.packTarget))
    ) {
      return {
        ok: false,
        status: "native-not-eligible",
        message:
          `${query.harnessId} has not been certified on ` +
          `${query.packTarget ?? "this architecture"} yet (certified: ` +
          `${manifest.nativeTargets.join(", ") || "none"}).`,
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

  // Attended native turns cannot use unrestricted permissions. Authorized
  // evals and swarms deliberately run as the OS user without containment.
  if (
    query.scope !== "unattended" &&
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

  // An unattended run of a harness that depends on its OWN command sandbox
  // (D2, Codex) needs that sandbox measured on this exact target. Anywhere
  // else it is refused — never run without the sandbox. A caller that cannot
  // state its target is refused too: this is the gate, not a hint.
  if (
    query.permissionProfile === "unrestricted" &&
    query.targetKind === "local-native" &&
    manifest.unattendedSandboxTargets !== undefined &&
    (query.packTarget == null ||
      !manifest.unattendedSandboxTargets.includes(query.packTarget))
  ) {
    return {
      ok: false,
      status: "backend-not-verified",
      message:
        `unattended local ${query.harnessId} runs inside its own command ` +
        `sandbox, and that sandbox has not been verified on ` +
        `${query.packTarget ?? "this architecture"} yet (verified: ` +
        `${manifest.unattendedSandboxTargets.join(", ") || "none"}). ` +
        `Run this eval or swarm in the cloud.`,
    };
  }

  return { ok: true, manifest, permissionMode };
}
