/**
 * The side-effecting probes, kept out of the browser-safe barrel.
 *
 * `claude-readiness/index.ts` is re-exported from `@mcpjam/sdk/browser`, and
 * its header promises pure data and data reasoning. A function that registers
 * an OAuth client at a stranger's authorization server is neither, and a
 * browser bundle should not be able to import one at all. The gate and the
 * grading stay in the pure barrel; only the sockets live here.
 */

export {
  probeDynamicRegistration,
  probeRefreshRotation,
} from "./intrusive.js";
export type { ClaudeIntrusiveProbeOptions } from "./intrusive.js";
