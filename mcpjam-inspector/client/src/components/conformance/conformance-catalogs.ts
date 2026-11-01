// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  APPS_CHECK_CATALOG,
  CHECK_ERAS,
  CONFORMANCE_CHECK_METADATA,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_TASKS_CHECK_IDS,
  PROTOCOL_CHECK_CATALOG,
  PROTOCOL_VERSION_ERAS,
  TASKS_CHECK_CATALOG,
  type OAuthConformanceCheckId,
} from "@mcpjam/sdk/browser";
import type { ProtocolVersionPin } from "@/hooks/use-conformance-run";
import type { CatalogEntry } from "./ConformanceCheckRows";

/**
 * The protocol suite is era-gated: a pinned version runs only its own era's
 * checks. With a pin we filter to exactly what will run; on "auto" the era is
 * unknown until the connection negotiates, so we list everything and tag the
 * checks that are era-restricted rather than implying they all apply.
 */
export function protocolCatalog(pin: ProtocolVersionPin): CatalogEntry[] {
  const pinnedEra = pin === "auto" ? undefined : PROTOCOL_VERSION_ERAS[pin];
  return MCP_CHECK_IDS.filter((id) => {
    const eras = CHECK_ERAS[id] as readonly string[];
    return pinnedEra === undefined || eras.includes(pinnedEra);
  }).map((id) => {
    const eras = CHECK_ERAS[id] as readonly string[];
    return {
      id,
      ...PROTOCOL_CHECK_CATALOG[id],
      note:
        pinnedEra === undefined && eras.length === 1
          ? `${eras[0]} only`
          : undefined,
    };
  });
}

export const APPS_CATALOG: CatalogEntry[] = MCP_APPS_CHECK_IDS.map((id) => ({
  id,
  ...APPS_CHECK_CATALOG[id],
}));

export const TASKS_CATALOG: CatalogEntry[] = MCP_TASKS_CHECK_IDS.map((id) => ({
  id,
  ...TASKS_CHECK_CATALOG[id],
}));

// Only the post-flow checks have static identities. The authorization flow
// steps themselves depend on the server's registration strategy and protocol
// version, so they are discovered during the run rather than listed here.
export const OAUTH_CATALOG: CatalogEntry[] = (
  Object.keys(CONFORMANCE_CHECK_METADATA) as OAuthConformanceCheckId[]
).map((id) => ({
  id,
  title: CONFORMANCE_CHECK_METADATA[id].title,
  description: CONFORMANCE_CHECK_METADATA[id].summary,
}));

/** A saved run does not record its pin, so its protocol list is the "auto" one. */
export function suiteCatalog(suiteKind: string): CatalogEntry[] {
  switch (suiteKind) {
    case "protocol":
      return protocolCatalog("auto");
    case "apps":
      return APPS_CATALOG;
    case "tasks":
      return TASKS_CATALOG;
    case "oauth":
      return OAUTH_CATALOG;
    default:
      return [];
  }
}
