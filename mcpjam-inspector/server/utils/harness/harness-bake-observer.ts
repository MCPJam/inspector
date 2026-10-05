/**
 * Observes the framework's bootstrap marker traffic on a hosted turn's box and
 * turns it into the bootstrap fields of the `[harness][timing]` line. See
 * `harness-bake.ts` for what the bake is and why a miss is worth recording.
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
 *  - `reused`: the marker was there because an EARLIER turn installed it (a
 *    persistent computer from an unbaked template, or after drift);
 *  - `none`: no recipe was applied (no observed marker access).
 */
export type HarnessBootstrapOutcome = "baked" | "installed" | "reused" | "none";

/**
 * Whether this turn should have hit a baked marker, and if not, why not.
 * `custom-workdir` and `unbaked-recipe` are INTENTIONAL fallbacks; a miss with
 * `baked` is the thing worth alerting on.
 */
export type HarnessBakeExpectation =
  "baked" | "custom-workdir" | "unbaked-recipe" | "none";

/** Whether the box carries a bake manifest at all (checked only on a miss). */
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
 * extra I/O is ONE read of the bake manifest after a miss — off the critical
 * path (not awaited), and on a turn that is about to spend minutes installing
 * anyway. Read the result with {@link harnessBootstrapObservation}.
 */
export function observeHarnessBootstrap(
  provider: HarnessV1SandboxProvider,
): HarnessV1SandboxProvider {
  const state: {
    defaultWorkingDirectory?: string;
    bootstrapDir?: string;
    identity?: string;
    found?: "baked" | "reused";
    installed: boolean;
    bakedVersions?: string;
    bakeId?: string;
    bakeOnBox: Promise<HarnessBakeOnBox> | null;
  } = { installed: false, bakeOnBox: null };

  const noteMarker = (path: string, cwd: string) => {
    const match = MARKER_PATH.exec(path);
    if (!match) return null;
    state.defaultWorkingDirectory = cwd;
    state.bootstrapDir = posix.relative(cwd, match[1]!) || ".";
    state.identity = match[2];
    return match;
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
            if (state.bakeOnBox === null) {
              state.bakeOnBox = Promise.resolve(
                probe.readTextFile({ path: HARNESS_BAKE_MANIFEST_PATH }),
              ).then(
                (manifest): HarnessBakeOnBox =>
                  manifest === null ? "absent" : "present",
                (): HarnessBakeOnBox => "unknown",
              );
            }
          } else {
            const baked = parseBakedMarker(result);
            state.found = baked ? "baked" : "reused";
            if (baked?.versions) state.bakedVersions = baked.versions;
            if (baked?.bakeId) state.bakeId = baked.bakeId;
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
      : (state.found ?? "none");
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
      bakeOnBox: "not-checked",
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
 * Awaits the post-miss manifest probe for at most `probeTimeoutMs`: it was
 * started when the miss happened, so by the time a turn logs it has long
 * settled; the bound only keeps a wedged box from holding the log line.
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
 * The bootstrap fields of the `[harness][timing]` line: inline `key=value`
 * text (the console drops the context argument) and the same values as a
 * structured context for Axiom, plus the pinned runtime version.
 *
 * A miss on a box that HAS a bake manifest, for a recipe and working directory
 * the template covers, is drift — the template baked a different identity than
 * this inspector resolves — and is logged as its own warning so it does not
 * have to be computed out of the timing line to be seen.
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
  if (
    observation.expectation === "baked" &&
    observation.outcome !== "baked" &&
    observation.bakeOnBox === "present"
  ) {
    logger.warn(
      `[harness][bake-drift] box carries a harness bake but not this recipe's marker; recipe=${
        observation.bootstrapDir ?? "?"
      }@${observation.identity ?? "?"} bootstrap=${observation.outcome}`,
      context,
    );
  }
  return { text, context };
}
