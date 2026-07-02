import { buildMarketHostProfiles } from "@mcpjam/sdk/host-compat";
import type { HostCompatProfile } from "./types";

/**
 * Client presentation join for the SDK's market-host catalog.
 *
 * The host *facts* (which bridges each host renders, its capability matrix,
 * advertised protocol versions, provenance) come from the SDK's logo-free
 * `buildMarketHostProfiles()`. The inspector adds the per-host logos here — the
 * one piece of presentation the SDK deliberately doesn't carry — joined by
 * host id.
 */
const LOGO_BY_ID: Record<
  string,
  { logoSrc: string; logoSrcByTheme?: { light: string; dark: string } }
> = {
  claude: { logoSrc: "/claude_logo.png" },
  chatgpt: { logoSrc: "/openai_logo.png" },
  mistral: { logoSrc: "/mistral_logo.png" },
  goose: {
    logoSrc: "/goose_logo_light.png",
    logoSrcByTheme: {
      light: "/goose_logo_light.png",
      dark: "/goose_logo_dark.png",
    },
  },
  cursor: { logoSrc: "/cursor_logo.png" },
  copilot: { logoSrc: "/copilot_logo.png" },
  codex: { logoSrc: "/codex-logo.svg" },
  n8n: { logoSrc: "/n8n_logo.svg" },
  perplexity: { logoSrc: "/perplexity_logo.svg" },
  cline: {
    logoSrc: "/cline_logo_light.svg",
    logoSrcByTheme: {
      light: "/cline_logo_light.svg",
      dark: "/cline_logo_dark.svg",
    },
  },
};

// The joined profile array is a pure function of the SDK catalog + the static
// logo map, so build it once. Every connected server's memoized
// `useHostCompatReports` calls into `evaluateAllHosts` on each tools/widget/
// protocol change, which would otherwise rebuild this byte-identical array
// (SDK calls + logo joins) every time.
let cachedProfiles: HostCompatProfile[] | null = null;

export function buildHostCompatProfiles(): HostCompatProfile[] {
  if (cachedProfiles) return cachedProfiles;
  cachedProfiles = buildMarketHostProfiles().map((p) => ({
    ...p,
    logoSrc: LOGO_BY_ID[p.id]?.logoSrc ?? "",
    logoSrcByTheme: LOGO_BY_ID[p.id]?.logoSrcByTheme,
  }));
  return cachedProfiles;
}

/**
 * Profiles keyed by host id — used by the engine adapter to join logos +
 * `rendersWidgets` onto the SDK's logo-free reports.
 */
export const PROFILE_BY_ID: Record<string, HostCompatProfile> =
  Object.fromEntries(buildHostCompatProfiles().map((p) => [p.id, p]));
