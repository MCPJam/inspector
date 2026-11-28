import type { FeatureDefinition } from "../types.js";
import { CORE_FEATURES } from "./core/index.js";
import { EXTENSION_FEATURES } from "./extensions/index.js";

/** Every feature the canvas shows, in display order. */
export const SERVER_FEATURE_CATALOG: readonly FeatureDefinition[] = [
  ...CORE_FEATURES,
  ...EXTENSION_FEATURES,
];
