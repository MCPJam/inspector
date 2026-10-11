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
 * TEMPORARY for the harness entry: retire it once every runner version
 * declares it. The browser-secrets entry below is conditional, not temporary.
 */
import { browserSecretPlaceholdersEnabled } from "../../config.js";
import { SWARM_SPONSORSHIP_CAPABILITY } from "../../../shared/swarm-sponsorship.js";
import { hasServiceCredential } from "../service-credential.js";

const HARNESS_EXECUTION = "harness-execution";

/**
 * This runner can put materialized secrets into a browser (only, not the box's
 * shell or harness). Declared only while `MCPJAM_BROWSER_SECRET_PLACEHOLDERS`
 * is on, since with it off no secret is actually delivered; the backend uses
 * it to lift its materialized-secret launch gates.
 */
const BROWSER_MATERIALIZED_SECRETS = "browser-materialized-secrets";

/** A function so the flag is read at call time, not frozen at module load. */
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
 * Swarm-only: this server can attest a sponsored (MCPJam-paid) swarm
 * conversation. Kept out of {@link runnerCapabilities} because evals share that
 * list and have no sponsored conversations.
 *
 * Declared only while INSPECTOR_SERVICE_TOKEN is set. The token is the proof
 * the backend requires on every sponsored call, so advertising the capability
 * without it would let the backend allocate sponsored conversations this
 * process could only fail. An older runner never sends the string, so the
 * backend allocates it nothing.
 */
export function swarmSponsorshipCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return hasServiceCredential(env)
    ? [SWARM_SPONSORSHIP_CAPABILITY]
    : [];
}

/**
 * The harnesses THIS runner will execute on the member's machine for a launch
 * that asks for the local venue: one `local-harness:<id>` per harness.
 *
 * The backend stamps a target local only for a harness the runner declares
 * here (a runner that declares none is read as one that predates the
 * declaration, for which the local venue means Claude Code alone). So a launch
 * declares exactly the harnesses it has checked it can run — machine, rollout
 * and authorization — and a Codex host is never stamped local for a runner
 * that would not run it there, nor a Claude Code host for one that can run
 * only Codex. Sorted and de-duplicated so the list hashes stably.
 */
export function localHarnessCapabilities(
  harnessIds: readonly string[] | undefined,
): string[] {
  return [...new Set(harnessIds ?? [])].sort().map((id) => `local-harness:${id}`);
}

/** @deprecated Use {@link runnerCapabilities}, which reads the flag at call time. */
export const RUNNER_CAPABILITIES = [HARNESS_EXECUTION] as const;
