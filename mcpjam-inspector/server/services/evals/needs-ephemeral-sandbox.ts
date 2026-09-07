/**
 * Does this eval iteration need a disposable box booted for it, and WHICH KIND?
 *
 * Its own module, not an inline condition in the runner, because the rule is
 * load-bearing and was previously untestable without driving a whole iteration
 * — which is how the harness half of it went missing.
 */
import { parseBrowserToolPolicy } from "./browser-tool-policy.js";

const BROWSER_BUILT_IN_TOOL_ID = "browser";

export interface EphemeralEvalSandboxNeed {
  needed: boolean;
  /**
   * WHICH IMAGE. `desktop-browser` boots an X session with Chromium on it and
   * costs several times a terminal box, so it is only ever chosen for the one
   * reason that requires it.
   */
  runtimeKind: "terminal" | "desktop-browser";
}

/**
 * THREE reasons an iteration needs a box, not two:
 *
 *   - the run PINS a computer image — the box IS the reproducible environment
 *     the author asked for, and `bash` is exposed from it;
 *   - the run executes on a HARNESS — the harness needs a machine to be, and
 *     the only alternative `runHarnessTurn` has is `resolveHarnessSandbox`,
 *     i.e. the acting member's PERSONAL computer. Booting our own is what keeps
 *     eval execution off a shared, stateful box, so this must not be
 *     conditional on an image: an unpinned harness run simply gets the
 *     deployment-default template. The control plane resolves which image that
 *     is, so the provision call still names no template.
 *   - the run declares a BROWSER — same reasoning, one layer over: the hosted
 *     engine has one computer per (project, member), so without a box of its
 *     own every unattended run in a project would drive the same Chromium, the
 *     same tab and the same cookie jar, and the ephemeral profile that
 *     isolation needs would relaunch the daemon a person may be using.
 *
 * A harness or browser run that boots no box does not fail loudly — it
 * silently runs on someone's personal computer, or is silently advertised
 * nothing. That is why both arms are here rather than left to a later "did we
 * get a binding?" check.
 *
 * BOTH HALVES ARE REQUIRED for the browser arm. The tool has to be attached
 * AND a policy declared: nothing in an unattended run can approve a click, so
 * a policy-less `browser` advertises no tools at all — and provisioning a
 * desktop box for a run that will use nothing is money for nothing, refused a
 * moment later by the control plane as `desktop_not_advertised`.
 *
 * `runId` absent is the SINGLE-CASE surface, which never provisions (both
 * provisioning sites require a run). Admission refuses a harness there rather
 * than letting it reach the personal-computer fallback with no box.
 */
export function needsEphemeralEvalSandbox(args: {
  pinnedEnvironmentId?: string | undefined;
  harness?: string | undefined;
  /** The iteration's frozen `builtInToolIds`. */
  builtInToolIds?: readonly string[] | undefined;
  /** The host config's declared unattended browser policy, unparsed. */
  browserToolPolicy?: unknown;
  runId: unknown;
}): EphemeralEvalSandboxNeed {
  if (args.runId === null || args.runId === undefined) {
    return { needed: false, runtimeKind: "terminal" };
  }
  const wantsBrowser =
    (args.builtInToolIds ?? []).includes(BROWSER_BUILT_IN_TOOL_ID) &&
    parseBrowserToolPolicy(args.browserToolPolicy, {
      source: "needs-ephemeral-sandbox",
    }) !== undefined;
  if (wantsBrowser) {
    // A browser needs the DESKTOP image whatever else is true. A pinned
    // environment alongside it is refused by the control plane
    // (`desktop_pin_conflict`) with a sentence the run surfaces — deliberately
    // there rather than here, so one place decides it and the message that
    // reaches the user is the same on both surfaces.
    return { needed: true, runtimeKind: "desktop-browser" };
  }
  return {
    needed: Boolean(args.pinnedEnvironmentId) || Boolean(args.harness),
    runtimeKind: "terminal",
  };
}
