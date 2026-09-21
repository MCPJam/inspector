/**
 * What can reach a per-run eval box once it has booted.
 *
 * Its own module for the same reason as {@link needsEphemeralEvalSandbox}: the
 * rule decides whether a case's attachments are seeded, and as an inline
 * condition in the runner the only way to exercise it was to drive a whole
 * iteration — so an iteration that quietly ran without its files looked
 * exactly like one that had none.
 */

/** The image classes a per-run eval box can boot as. */
export type EvalBoxRuntimeKind = "terminal" | "desktop-browser";

/**
 * Can ANYTHING in this iteration read the box's filesystem?
 *
 * Two ways in, and the second is the one that is easy to miss:
 *
 *   - the EMULATED path reaches the box only through the out-of-band `bash`
 *     tool, which exists on a TERMINAL box alone — `browser` and `bash` are
 *     mutually exclusive on a host config, so a desktop box never offers one;
 *   - a HARNESS runs ON the box (`harnessSandboxBinding`) and brings its own
 *     file tools with it, whatever the image class.
 *
 * So a harness eval that ALSO declares a browser policy gets a desktop box it
 * can read perfectly well. Keying the seed on `terminal` alone dropped that
 * case's attachments and left its prompt un-annotated — silently, because a
 * harness handed no files still produces a transcript.
 *
 * The caller passes what ACTUALLY booted, not what it asked for.
 */
export function evalBoxFilesystemIsReachable(args: {
  runtimeKind: EvalBoxRuntimeKind;
  harness?: string | undefined;
}): boolean {
  return args.runtimeKind === "terminal" || args.harness !== undefined;
}
