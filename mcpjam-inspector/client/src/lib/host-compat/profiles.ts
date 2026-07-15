import {
  buildHostProfilesFromCatalog,
  buildMarketHostProfiles,
  type HostCompatCatalog,
  type HostCompatProfile as SdkHostCompatProfile,
} from "@mcpjam/sdk/host-compat";
import type { HostCompatProfile } from "./types";
import { getHostLogoSrc, HOST_LOGO_OPTIONS } from "@/lib/host-ui-metadata";

/**
 * Client presentation join for the SDK's market-host catalog.
 *
 * The host *facts* (which bridges each host renders, its capability matrix,
 * advertised protocol versions, provenance) come from the SDK's logo-free
 * `buildMarketHostProfiles()`. The inspector adds the per-host logos here — the
 * one piece of presentation the SDK deliberately doesn't carry — joined by
 * host id.
 */
const LOGO_THEME_BY_ID = Object.fromEntries(
  HOST_LOGO_OPTIONS.map((option) => [option.id, option.logoSrcByTheme])
);

function joinLogo(p: SdkHostCompatProfile): HostCompatProfile {
  return {
    ...p,
    logoSrc: getHostLogoSrc(p.id),
    logoSrcByTheme: LOGO_THEME_BY_ID[p.id],
  };
}

// The joined profile array is a pure function of the SDK catalog + the static
// logo map, so build it once. Every connected server's memoized
// `useHostCompatReports` calls into `evaluateAllHosts` on each tools/widget/
// protocol change, which would otherwise rebuild this byte-identical array
// (SDK calls + logo joins) every time.
let cachedProfiles: HostCompatProfile[] | null = null;

export function buildHostCompatProfiles(): HostCompatProfile[] {
  if (cachedProfiles) return cachedProfiles;
  cachedProfiles = buildMarketHostProfiles().map(joinLogo);
  return cachedProfiles;
}

/**
 * Logo-joined profiles for an explicit catalog (the live fetch from
 * `useHostCatalog`); no catalog = the cached bundled profiles. Live catalogs
 * aren't cached here — `useHostCatalog` resolves once per page load and
 * consumers memoize on its state.
 */
export function getHostProfiles(
  catalog?: HostCompatCatalog | null
): HostCompatProfile[] {
  if (!catalog) return buildHostCompatProfiles();
  return buildHostProfilesFromCatalog(catalog).map(joinLogo);
}

/**
 * Profiles keyed by host id — used by the engine adapter to join logos +
 * `rendersWidgets` onto the SDK's logo-free reports.
 */
export const PROFILE_BY_ID: Record<string, HostCompatProfile> =
  Object.fromEntries(buildHostCompatProfiles().map((p) => [p.id, p]));
