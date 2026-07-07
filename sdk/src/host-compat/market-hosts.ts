/**
 * Market-host entry points. The data and derivation moved to `catalog.ts`
 * when the host-compat catalog became backend-publishable (data/engine
 * split); this module keeps the original import path stable.
 */
export {
  buildMarketHostProfiles,
  evaluateMarketHosts,
  type EvaluateMarketHostsOptions,
} from "./catalog.js";
