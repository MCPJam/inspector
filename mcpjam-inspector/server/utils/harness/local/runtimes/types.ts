/**
 * Everything the local runner needs to know about ONE runtime to run it on the
 * member's own computer.
 *
 * The runner is generic: it supervises, translates, verifies and authorizes the
 * same way for every runtime, and reads what differs from the runtime's
 * definition (`runtimes/<harnessId>.ts`). Anything that would otherwise be an
 * `if (harnessId === …)` in the runner belongs in this interface instead —
 * `local-runtimes.test.ts` fails on a harness id written into the runner.
 *
 * How a runtime becomes local is in `index.ts`.
 */
import type { HarnessAuth } from "../../registry.js";
import type { LocalHarnessCompatibility } from "../compatibility.js";
import type { LocalPackTarget, SupportedLocalHarnessId } from "../targets.js";

/** What the child is handed instead of a model lease: the local model
 *  gateway's loopback URL and a capability that means nothing elsewhere. */
export interface LocalModelGatewayEndpoint {
  baseUrl: string;
  sessionCapability: string;
}

/**
 * Which files of a verified runtime pack are re-hashed before every spawn.
 *
 * The full tree digest runs once per process per pack; every spawn after that
 * re-checks a stat snapshot and re-reads the bytes of the files listed here
 * (see `runtime-identity.ts` for the cost split behind the two tiers). What a
 * pack EXECUTES differs by runtime, so the list is the runtime's to declare.
 */
export interface RuntimeRehashPolicy {
  /** Re-hashed on every spawn: the pack's JavaScript entrypoints, which are
   *  small enough to read every time. (The bridge and its launcher are not
   *  pack files any more: the Inspector layer re-hashes them in full before
   *  every exec — `inspector-layer.ts`.) */
  always: readonly string[];
  /** Re-hashed under `MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY=true`: the large
   *  binaries. Matched by pattern because vendor paths are platform-suffixed. */
  strict: readonly RegExp[];
}

/**
 * How a CANDIDATE pack's vendor CLI proves which version it is, before
 * anything selects the pack (`runtime-probe.ts`). Paths are segments relative
 * to the pack root.
 */
export interface VendorProbe {
  /** A script run by the pack's own `bin/node`, or a native binary. */
  run: { node: readonly string[] } | { binary: readonly string[] };
  args: readonly string[];
  /** `stdout`: any semver the CLI prints. `package-json`: the version in that
   *  manifest, which the CLI's output must contain. */
  version: { from: "stdout" } | { from: "package-json"; path: readonly string[] };
}

export interface LocalRuntime<
  Id extends SupportedLocalHarnessId = SupportedLocalHarnessId,
> {
  harnessId: Id;
  /** The reviewed compatibility manifest: pack policy, permission mapping,
   *  platforms and conformance. An adapter never asserts these itself. */
  manifest: LocalHarnessCompatibility & { harnessId: Id };
  /** The version of the adapter actually compiled into or installed beside
   *  this server, compared against `manifest.adapterVersion`. Read from the
   *  build rather than the manifest, or the pin would be checked against
   *  itself. */
  installedAdapterVersion(): string;
  /**
   * The command shapes the pinned adapter emits, for the closed translation
   * grammar (`command-translation.ts`). Nothing outside these is ever run.
   */
  commands: {
    /** Every shape, as reviewed. Documentation and the translator's tests. */
    shapes: readonly string[];
    /** The adapter's vendor install, a no-op locally: the pack is the graph. */
    install: string;
    /** The adapter's vendor version check, answered from the verified pack. */
    versionProbe: string;
    /** The bridge launch's exact flag vector, in order. */
    bridgeFlags: readonly string[];
    /** Flags whose paths are runtime state, kept in the session's own state
     *  directory and never in the granted workspace. */
    sessionStateFlags: readonly string[];
  };
  /** The Inspector layer's files for this runtime besides `launcher.mjs` and
   *  `layer.json`, as `scripts/bundle-local-harness-layer.mjs` names them. */
  layerFiles: readonly string[];
  rehash: RuntimeRehashPolicy;
  vendorProbe(pack: { target: LocalPackTarget; platform: NodeJS.Platform }): VendorProbe;
  /** Project secrets may not use these names: they are where this runtime
   *  reads its model endpoint and credential. */
  reservedSecretEnv: RegExp;
  /** The vendor variables this runtime's adapter may hand its bridge on a
   *  spawn, besides the bridge's own channel. Anything else it offers is
   *  dropped, so an adapter change cannot quietly add one. */
  bridgeEnv: readonly string[];
  /** How the child authenticates, and so what a turn obtains before anything
   *  spawns. */
  credential: LocalRuntimeCredential;
  /** Runs shell commands through Git for Windows on Windows. */
  gitBashOnWindows: boolean;
}

/** A login the backend exchanged from the organization's own key for one
 *  turn: the vendor's access token, which expires within the hour. */
export interface LocalRuntimeLogin {
  accessToken: string;
  expiresAt: number;
}

/**
 * How a runtime's child authenticates (`turn-credential.ts` obtains it).
 *
 *   gateway        MCPJam brokers the model. The turn takes a lease, holds it
 *                  in a loopback gateway, and the child gets the gateway and a
 *                  capability that means nothing elsewhere, named the way its
 *                  CLI reads them. The lease never reaches the child.
 *   runtime-login  The CLI reaches its own vendor on the organization's
 *                  account (Cursor), so no gateway can stand in front of it.
 *                  The backend exchanges the org key for a short-lived login,
 *                  and the supervised process starts with it in its
 *                  environment; the CLI keeps it in memory only. The adapter,
 *                  which runs in this Inspector, gets an explicit environment
 *                  instead, so it never looks for a login of the member's own
 *                  on this machine. The org key never leaves the backend.
 */
export type LocalRuntimeCredential =
  | { kind: "gateway"; childAuth(gateway: LocalModelGatewayEndpoint): HarnessAuth }
  | {
      kind: "runtime-login";
      adapterAuth: HarnessAuth;
      childEnv(login: LocalRuntimeLogin): Readonly<Record<string, string>>;
    };
