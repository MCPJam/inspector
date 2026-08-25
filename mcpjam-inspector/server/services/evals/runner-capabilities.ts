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
 * TEMPORARY. Retire the arg (and this module) once every runner version in
 * the wild declares it; the backend can then pin `harness` unconditionally.
 */
export const RUNNER_CAPABILITIES = ["harness-execution"] as const;
