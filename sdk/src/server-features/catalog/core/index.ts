import type { FeatureDefinition } from "../../types.js";
import { SERVER_INFO_FEATURES } from "./server-info.js";

/**
 * Families 1–17 (core protocol), in `FEATURE_FAMILY_IDS` order. Each file
 * follows the audit 2 inventory's leaf order within its families.
 */
export const CORE_FEATURES: readonly FeatureDefinition[] = [
  ...SERVER_INFO_FEATURES,
];
