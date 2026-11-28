import type { Context } from "hono";
import { getAttestedCountry } from "./client-ip";

// Visitors from the EU, the rest of the EEA and the UK must opt in before
// optional analytics or session replay start. The French outermost regions
// and Åland are EU territory with their own country codes.
const CONSENT_REQUIRED_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
  "GF", "GP", "MQ", "RE", "YT", "MF", "AX",
  "IS", "LI", "NO",
  "GB",
]);

// An unknown location needs consent too: no country (a local install, or a
// request that bypassed the edge), XX, and Tor's T1.
export function analyticsConsentRequired(country: string | null): boolean {
  if (!country || !/^[A-Z]{2}$/.test(country) || country === "XX") return true;
  return CONSENT_REQUIRED_COUNTRIES.has(country);
}

/** The document script the client reads in `lib/analytics-consent.ts`. */
export function buildAnalyticsConsentScript(c: Context): string {
  const required = analyticsConsentRequired(getAttestedCountry(c));
  return `<script>window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__=${required};</script>`;
}
