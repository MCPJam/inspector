/**
 * What THIS runner build can actually execute — declared to the backend at run
 * creation, and forwarded to the pre-run disclosure so both answers agree
 * (the mixed-version-rollout handshake, "D5").
 *
 * The backend pins a run's host config at run start and stamps the run's
 * `executionEngine` from it. If it pinned `harness` unconditionally, a run
 * created by an OLDER runner — a desktop or local inspector that predates the
 * harness execution wiring but talks to the same hosted Convex — would be
 * stamped `harness:claude-code` while that runner went on quietly emulating.
 * That is worse than the bug this program is fixing: today's silent emulation
 * at least isn't labelled, and a false stamp would make it unfalsifiable.
 *
 * So the backend copies `harness` into the run snapshot only when the creating
 * runner says it can honour it. A runner that declares nothing keeps today's
 * behavior — stripped selector, `emulated` stamp — which is honest about what
 * it will do.
 *
 * TWO CALLERS, ONE LIST, and that is the point rather than tidiness:
 * `startSuiteRunWithRecorder` declares it when it creates a run, and
 * `eval-disclosure.ts` forwards it when it asks what a run WOULD do.
 * `testSuites:getRunDisclosure` gates its disclosed engine on this handshake
 * exactly as the launch gates the run's pinned config, so a disclosure
 * computed from a different list than the launch declares would describe an
 * engine the launch never uses — which is precisely the failure this contract
 * exists to rule out. The route ASSERTS this rather than accepting it from
 * the query: this process is the runner, so it is the only honest source for
 * what it can execute, and a caller-supplied value could claim a capability
 * the runner does not have and be believed.
 *
 * A LEAF MODULE on purpose. It lived in `recorder.ts` until the disclosure
 * route needed it, and importing the recorder from a route drags the whole
 * eval-runner dependency graph (and its `@/` path aliases) behind one string
 * constant.
 *
 * TEMPORARY for the harness entry. Retire it once every runner version in the
 * wild declares it; the backend can then pin `harness` unconditionally. The
 * browser-secrets entry below is not temporary in the same way — it says which
 * of two deliveries this process actually has.
 */
import { browserSecretPlaceholdersEnabled } from "../../config.js";

const HARNESS_EXECUTION = "harness-execution";

/**
 * This runner can put a project's materialized secrets INTO A BROWSER.
 *
 * Declared — and therefore promised — only while
 * `MCPJAM_BROWSER_SECRET_PLACEHOLDERS` is on, because that flag is what makes
 * the promise true: with it off, `resolveBrowserSecrets` returns nothing and
 * every `{{secret:NAME}}` an eval writes is refused as unknown. Declaring it
 * unconditionally would be this process claiming a delivery it does not have,
 * which is exactly the failure the header above describes for `harness`.
 *
 * WHAT THE BACKEND DOES WITH IT. Four gates refuse to launch or provision a
 * run whose environment selects a materialized secret, because an eval or
 * journey box receives none and the run would score with the credential
 * silently absent. This declaration lifts them — for the BROWSER's sake only.
 * The box's shell and any harness on it still receive nothing, which is why
 * the string says `browser-` and why the backend's constant carries the same
 * caveat. A runner that declares it is accepting that narrower position.
 */
const BROWSER_MATERIALIZED_SECRETS = "browser-materialized-secrets";

/**
 * What THIS process can do, as it is configured right now.
 *
 * A function rather than a constant because one of the two entries is
 * conditional, and READ AT CALL TIME like the flag it follows: a module
 * constant would freeze whatever the environment said when this module first
 * loaded, which is wrong for a switch that is flipped per-process in staging
 * and per-test.
 */
export function runnerCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return [
    HARNESS_EXECUTION,
    ...(browserSecretPlaceholdersEnabled(env)
      ? [BROWSER_MATERIALIZED_SECRETS]
      : []),
  ];
}

/**
 * @deprecated Use {@link runnerCapabilities}, which reads the flag at call
 * time. Kept so an importer that only cares about harness execution — and
 * there is no such importer left in this repository — still compiles.
 */
export const RUNNER_CAPABILITIES = [HARNESS_EXECUTION] as const;
