/**
 * Conformance check → feature map types. Each suite's map is exhaustive over
 * its check-id union (`satisfies Record<…>` in the filled file), so a new
 * check without a mapping fails typecheck. `"excluded"` is a reviewed
 * decision that a check is not evidence for any single catalog feature.
 */

import type { MCPCheckId } from "../../mcp-conformance/types.js";
import type { MCPAppsCheckId } from "../../apps-conformance/types.js";
import type { MCPTasksCheckId } from "../../tasks-conformance/types.js";
import type { EventsCheckId } from "../../events-conformance/types.js";
import type { OAuthConformanceCheckId } from "../../oauth-conformance/types.js";

export type CheckFeatureTarget = readonly string[] | "excluded";

export type ProtocolCheckFeatureMap = Record<MCPCheckId, CheckFeatureTarget>;
export type AppsCheckFeatureMap = Record<MCPAppsCheckId, CheckFeatureTarget>;
export type TasksCheckFeatureMap = Record<MCPTasksCheckId, CheckFeatureTarget>;
export type EventsCheckFeatureMap = Record<EventsCheckId, CheckFeatureTarget>;
export type OAuthCheckFeatureMap = Record<
  OAuthConformanceCheckId,
  CheckFeatureTarget
>;
