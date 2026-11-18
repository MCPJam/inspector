import type { FeatureDefinition } from "../../types.js";
import {
  LIFECYCLE_FEATURES,
  TRANSPORT_FEATURES,
} from "./lifecycle-transports.js";
import { SERVER_INFO_FEATURES } from "./server-info.js";
import { TOOL_RESULT_FEATURES } from "./tool-results.js";
import {
  TOOL_ANNOTATION_SCHEMA_FEATURES,
  TOOLS_DISCOVERY_FEATURES,
} from "./tools.js";
import { TRANSPORT_BEHAVIOR_FEATURES } from "./transport-behavior.js";

/**
 * Families 1–17 (core protocol), in `FEATURE_FAMILY_IDS` order. Each file
 * follows the audit 2 inventory's leaf order within its families.
 */
export const CORE_FEATURES: readonly FeatureDefinition[] = [
  ...SERVER_INFO_FEATURES,
  ...LIFECYCLE_FEATURES,
  ...TRANSPORT_FEATURES,
  ...TRANSPORT_BEHAVIOR_FEATURES,
  ...TOOLS_DISCOVERY_FEATURES,
  ...TOOL_ANNOTATION_SCHEMA_FEATURES,
  ...TOOL_RESULT_FEATURES,
];
