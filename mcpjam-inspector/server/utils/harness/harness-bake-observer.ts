/**
 * Observes the framework's bootstrap marker traffic on a hosted turn's box and
 * turns it into the bootstrap fields of the turn's log line — the
 * `[harness][timing]` line when the turn succeeds, the `[harness][bootstrap]`
 * line when it fails. See `harness-bake.ts` for what the bake is and why a
 * miss is worth recording.
 */
import { posix } from "node:path";
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { logger } from "../logger.js";
import {
  HARNESS_BAKE_HOME,
  HARNESS_BAKE_MANIFEST_PATH,
  HARNESS_BAKED_BOOTSTRAP_DIRS,
  parseBakedMarker,
} from "./harness-bake.js";

/**
 * What the framework's bootstrap step did on this turn's box:
 *  - `baked`: the marker was there and the TEMPLATE wrote it;
 *  - `installed`: the marker was missing and the framework ran the recipe;
 *  - `install-failed`: the marker was missing and no marker was ever written —
 *    the install did not complete (only seen on a failed turn: the pnpm 11 and
 *    deny-all-egress outages looked exactly like this);
 *  - `reused`: the marker was there because an EARLIER turn installed it (a
 *    persistent computer from an unbaked template, or after drift);
 *  - `none`: no recipe was applied (no observed marker access).
 */
export type HarnessBootstrapOutcome =
  "baked" | "installed" | "install-failed" | "reused" | "none";

/**
 * Whether this turn should have hit a baked marker, and if not, why not.
 * `custom-workdir` and `unbaked-recipe` are INTENTIONAL fallbacks; a miss with
 * `baked` is the thing worth alerting on.
 */
export type HarnessBakeExpectation =
  "baked" | "custom-workdir" | "unbaked-recipe" | "none";

/**
 * Whether the box carries a harness bake at all. A template marker is proof
 * (`present`, no extra read); anything else is answered by one read of the
 * bake manifest. `present` + a miss is drift; `absent` is a box from a
 * pre-bake template or a custom environment image.
 */
export type HarnessBakeOnBox = "present" | "absent" | "unknown" | "not-checked";

export interface HarnessBootstrapObservation {
  outcome: HarnessBootstrapOutcome;
  expectation: HarnessBakeExpectation;
  bakeOnBox: HarnessBakeOnBox;
  /** Bootstrap dir relative to the working directory, e.g.
   *  `.harness-bootstrap/claude-code`. */
  bootstrapDir?: string;
  /** The recipe identity in the marker the framework looked for. */
  identity?: string;
  /** The working directory the box was rooted at for this turn. */
  defaultWorkingDirectory?: string;
  /** Versions the template recorded in its marker (baked only). */
  bakedVersions?: string;
  /** The bake context id the template recorded in its marker (baked only). */
  bakeId?: string;
}

const MARKER_PATH = /^(.*)\/\.bootstrap-([0-9a-f]{16})\.ok$/;

/** The reduced session view the framework bootstraps through. */
type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession["restricted"]>;
type ReadTextFileOptions = Parameters<SandboxSession["readTextFile"]>[0];
type WriteTextFileOptions = Parameters<SandboxSession["writeTextFile"]>[0];

const observations = new WeakMap<
  HarnessV1SandboxProvider,
  () => HarnessBootstrapObservation
>();

/**
 * Wrap a provider so the framework's bootstrap marker traffic is observed.
 *
 * Purely passive: every call is forwarded unchanged and in order, and the only
 * extra I/O is ONE read of the bake manifest when the marker is not the
 * template's — off the critical path (not awaited), and on a turn that is
 * about to spend minutes installing anyway. Read the result with
 * {@link harnessBootstrapObservation}.
 */
export function observeHarnessBootstrap(
  provider: HarnessV1SandboxProvider,
): HarnessV1SandboxProvider {
  const state: {
    defaultWorkingDirectory?: string;
    bootstrapDir?: string;
    identity?: string;
    found?: "baked" | "reused";
    missed: boolean;
    installed: boolean;
    bakedVersions?: string;
    bakeId?: string;
    bakeOnBox: Promise<HarnessBakeOnBox> | null;
  } = { missed: false, installed: false, bakeOnBox: null };

  const noteMarker = (path: string, cwd: string) => {
    const match = MARKER_PATH.exec(path);
    if (!match) return null;
    state.defaultWorkingDirectory = cwd;
    state.bootstrapDir = posix.relative(cwd, match[1]!) || ".";
    state.identity = match[2];
    return match;
  };

  const probeBake = (probe: SandboxSession) => {
    state.bakeOnBox ??= Promise.resolve(
      probe.readTextFile({ path: HARNESS_BAKE_MANIFEST_PATH }),
    ).then(
      (manifest): HarnessBakeOnBox =>
        manifest === null ? "absent" : "present",
      (): HarnessBakeOnBox => "unknown",
    );
  };

  const wrapSession = <S extends SandboxSession>(
    session: S,
    cwd: string,
    probe: SandboxSession,
  ): S =>
    ({
      ...session,
      readTextFile: async (options: ReadTextFileOptions) => {
        const result = await session.readTextFile(options);
        if (noteMarker(options.path, cwd)) {
          if (result === null) {
            state.missed = true;
            probeBake(probe);
          } else {
            const baked = parseBakedMarker(result);
            state.found = baked ? "baked" : "reused";
            if (baked?.versions) state.bakedVersions = baked.versions;
            if (baked?.bakeId) state.bakeId = baked.bakeId;
            // The template's own marker proves the bake; anything else needs
            // the manifest to tell a pre-bake box from a drifted one.
            if (!baked) probeBake(probe);
          }
        }
        return result;
      },
      writeTextFile: async (options: WriteTextFileOptions) => {
        await session.writeTextFile(options);
        if (noteMarker(options.path, cwd)) state.installed = true;
      },
    }) as S;

  const wrapNetworkSession = async (
    pending: PromiseLike<HarnessV1NetworkSandboxSession>,
  ): Promise<HarnessV1NetworkSandboxSession> => {
    const session = await pending;
    const cwd = session.defaultWorkingDirectory;
    const wrapped = wrapSession(session, cwd, session);
    return {
      ...wrapped,
      // The framework applies the recipe through the RESTRICTED view, so that
      // is the one that has to be observed.
      restricted: () => wrapSession(session.restricted(), cwd, session),
    };
  };

  const observed: HarnessV1SandboxProvider = {
    ...provider,
    createSession: (options) =>
      wrapNetworkSession(provider.createSession(options)),
    ...(provider.resumeSession
      ? {
          resumeSession: (options) =>
            wrapNetworkSession(provider.resumeSession!(options)),
        }
      : {}),
  };

  observations.set(observed, () => {
    const outcome: HarnessBootstrapOutcome = state.installed
      ? "installed"
      : (state.found ?? (state.missed ? "install-failed" : "none"));
    let expectation: HarnessBakeExpectation = "none";
    if (state.bootstrapDir !== undefined) {
      expectation = !HARNESS_BAKED_BOOTSTRAP_DIRS.includes(state.bootstrapDir)
        ? "unbaked-recipe"
        : state.defaultWorkingDirectory !== HARNESS_BAKE_HOME
          ? "custom-workdir"
          : "baked";
    }
    return {
      outcome,
      expectation,
      bakeOnBox: state.found === "baked" ? "present" : "not-checked",
      ...(state.bootstrapDir !== undefined
        ? { bootstrapDir: state.bootstrapDir }
        : {}),
      ...(state.identity ? { identity: state.identity } : {}),
      ...(state.defaultWorkingDirectory
        ? { defaultWorkingDirectory: state.defaultWorkingDirectory }
        : {}),
      ...(state.bakedVersions ? { bakedVersions: state.bakedVersions } : {}),
      ...(state.bakeId ? { bakeId: state.bakeId } : {}),
    };
  });
  // The manifest probe resolves asynchronously; expose it to the log helper.
  bakeOnBoxProbes.set(observed, () => state.bakeOnBox);
  return observed;
}

const bakeOnBoxProbes = new WeakMap<
  HarnessV1SandboxProvider,
  () => Promise<HarnessBakeOnBox> | null
>();

/**
 * The observation for a provider built by {@link observeHarnessBootstrap}, or
 * undefined for one that was not (the local path supervises its own process
 * tree and has no template to hit).
 *
 * Awaits the manifest probe for at most `probeTimeoutMs`: it was started when
 * the marker was read, so by the time a turn logs it has long settled; the
 * bound only keeps a wedged box from holding the log line.
 */
export async function harnessBootstrapObservation(
  provider: unknown,
  probeTimeoutMs = 2_000,
): Promise<HarnessBootstrapObservation | undefined> {
  if (!provider || typeof provider !== "object") return undefined;
  const read = observations.get(provider as HarnessV1SandboxProvider);
  if (!read) return undefined;
  const observation = read();
  const probe = bakeOnBoxProbes.get(provider as HarnessV1SandboxProvider)?.();
  if (probe) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    observation.bakeOnBox = await Promise.race([
      probe,
      new Promise<HarnessBakeOnBox>((resolve) => {
        timer = setTimeout(() => resolve("unknown"), probeTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  return observation;
}

/**
 * The bootstrap fields of a turn's log line: inline `key=value` text (the
 * console drops the context argument) and the same values as a structured
 * context for Axiom, plus the pinned runtime version. The bake-miss monitor
 * (mcpjam-backend `ops/axiom-monitors/monitors/harness-bake-miss-rate.json`)
 * reads the context: a miss on a box with `bakeOnBox=present` is drift.
 */
export function harnessBootstrapLogFields(
  observation: HarnessBootstrapObservation | undefined,
  pinnedRuntimeVersion: string | undefined,
): { text: string; context: Record<string, string> } {
  if (!observation) return { text: "", context: {} };
  const context: Record<string, string> = {
    harnessBootstrap: observation.outcome,
    harnessBakeExpected: observation.expectation,
    harnessBakeOnBox: observation.bakeOnBox,
    ...(observation.bootstrapDir
      ? { harnessBootstrapDir: observation.bootstrapDir }
      : {}),
    ...(observation.identity
      ? { harnessRecipeIdentity: observation.identity }
      : {}),
    ...(pinnedRuntimeVersion
      ? { harnessRuntimePinned: pinnedRuntimeVersion }
      : {}),
    ...(observation.bakedVersions
      ? { harnessBakedVersions: observation.bakedVersions }
      : {}),
    ...(observation.bakeId ? { harnessBakeId: observation.bakeId } : {}),
  };
  const text =
    ` bootstrap=${observation.outcome}` +
    ` bakeExpected=${observation.expectation}` +
    ` bakeOnBox=${observation.bakeOnBox}` +
    (observation.identity
      ? ` recipe=${observation.bootstrapDir ?? "?"}@${observation.identity}`
      : "") +
    (pinnedRuntimeVersion ? ` runtimePinned=${pinnedRuntimeVersion}` : "") +
    (observation.bakedVersions
      ? ` bakedVersions=${observation.bakedVersions}`
      : "") +
    (observation.bakeId ? ` bakeId=${observation.bakeId}` : "");
  return { text, context };
}

/**
 * The failure-path counterpart of the `[harness][timing]` fields: logs
 * `[harness][bootstrap] turn=failed …` with the same structured context plus
 * `harnessTurn: "failed"`, so an install that never completed
 * (`bootstrap=install-failed`) is counted by the bake-miss monitor. Silent when
 * the provider was never observed or the turn failed before any bootstrap.
 * Never throws: a diagnostic must not escalate the failure it describes.
 */
export async function logHarnessBootstrapOnFailure(
  provider: unknown,
  pinnedRuntimeVersion: string | undefined,
): Promise<void> {
  try {
    const observation = await harnessBootstrapObservation(provider);
    if (!observation || observation.outcome === "none") return;
    const fields = harnessBootstrapLogFields(observation, pinnedRuntimeVersion);
    logger.info(`[harness][bootstrap] turn=failed${fields.text}`, {
      ...fields.context,
      harnessTurn: "failed",
    });
  } catch {
    // Best-effort diagnostics.
  }
}
