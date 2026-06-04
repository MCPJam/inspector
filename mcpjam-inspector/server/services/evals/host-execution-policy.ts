/**
 * Host execution policy + visibility filter + iteration metadata stamping.
 *
 * As of Stage 3 of the hostConfig consolidation, this module is a thin
 * re-export over `@mcpjam/sdk/host-config/internal`. The eval runtime
 * continues to import from this path so call sites don't churn, but the
 * authoritative implementation lives in the SDK alongside the canonical
 * hostConfig model. This also removes the eval path's reach into
 * `server/utils/chat-v2-orchestration` for `filterAppOnlyTools`.
 */

export {
  extractHostExecutionPolicy,
  buildHostIterationMetadata,
  applyVisibilityPolicyAndCountSignals,
} from "@mcpjam/sdk/host-config/internal";
export type {
  HostExecutionPolicy,
  ToolExposureSignals,
} from "@mcpjam/sdk/host-config/internal";
