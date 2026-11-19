/**
 * The side-effecting probes, kept out of the browser-safe barrel.
 *
 * `claude-readiness/index.ts` is re-exported from `@mcpjam/sdk/browser`, and
 * its header promises pure data and data reasoning. A function that registers
 * an OAuth client at a stranger's authorization server is neither, and a
 * browser bundle should not be able to import one at all. The gate and the
 * grading stay in the pure barrel; only the sockets live here.
 *
 * Three probes, each requiring an armed mode from `resolveClaudeIntrusiveMode`:
 * dynamic registration (with cleanup), refresh rotation and replay, and the
 * step-up challenge — one call to the declared read-only tool with the
 * caller's own token that lacks the tool's scope.
 */

export {
  probeDynamicRegistration,
  probeRefreshRotation,
  probeStepUpChallenge,
} from "./intrusive.js";
export type {
  ClaudeIntrusiveProbeOptions,
  ClaudeStepUpProbeOptions,
} from "./intrusive.js";
