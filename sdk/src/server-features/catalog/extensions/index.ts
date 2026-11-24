import type { FeatureDefinition } from "../../types.js";
import { APPS_FEATURES } from "./apps.js";
import { AUTHORIZATION_EXTENSION_FEATURES } from "./authorization.js";
import { EVENTS_FEATURES } from "./events.js";
import { SERVER_CARD_FEATURES } from "./server-cards.js";
import { SKILLS_FEATURES } from "./skills.js";
import { TASKS_FEATURES } from "./tasks.js";
import { THIRD_PARTY_FEATURES } from "./third-party.js";

export {
  KNOWN_EXPERIMENTAL_KEYS,
  KNOWN_EXTENSION_IDS,
  KNOWN_SERVER_CAPABILITY_KEYS,
  unrecognizedCapabilityKeys,
} from "./known-capabilities.js";

/** Families 18–24 (extensions, third-party, experimental), in display order. */
export const EXTENSION_FEATURES: readonly FeatureDefinition[] = [
  ...AUTHORIZATION_EXTENSION_FEATURES,
  ...APPS_FEATURES,
  ...TASKS_FEATURES,
  ...SKILLS_FEATURES,
  ...EVENTS_FEATURES,
  ...SERVER_CARD_FEATURES,
  ...THIRD_PARTY_FEATURES,
];
