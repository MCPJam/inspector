import type { FeatureDefinition } from "../../types.js";
import { AUTHORIZATION_EXTENSION_FEATURES } from "./authorization.js";

export {
  KNOWN_EXPERIMENTAL_KEYS,
  KNOWN_EXTENSION_IDS,
  KNOWN_SERVER_CAPABILITY_KEYS,
  unrecognizedCapabilityKeys,
} from "./known-capabilities.js";

/** Families 18–24 (extensions, third-party, experimental), in display order. */
export const EXTENSION_FEATURES: readonly FeatureDefinition[] = [
  ...AUTHORIZATION_EXTENSION_FEATURES,
];
