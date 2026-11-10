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
  MCP_OAUTH_READINESS_IDS,
  MCP_READINESS_IDS,
  MCP_TASKS_READINESS_IDS,
  OAUTH_READINESS_CATALOG,
  PROTOCOL_CHECK_CATALOG,
  PROTOCOL_VERSION_ERAS,
  READINESS_CATALOG,
  READINESS_ERAS,
  TASKS_CHECK_CATALOG,
  TASKS_READINESS_CATALOG,
  type OAuthConformanceCheckId,
} from "@mcpjam/sdk/browser";
import { useFeatureFlagEnabled } from "posthog-js/react";
import {
  TASK_ANSWERS_CHECK,
  type ConformanceSelection,
} from "@/shared/conformance-settings";
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

/** The protocol suite's advice, narrowed by a pin like its checks. */
export function protocolAdviceCatalog(pin: ProtocolVersionPin): CatalogEntry[] {
  const pinnedEra = pin === "auto" ? undefined : PROTOCOL_VERSION_ERAS[pin];
  return MCP_READINESS_IDS.filter((id) => {
    const eras = READINESS_ERAS[id] as readonly string[];
    return pinnedEra === undefined || eras.includes(pinnedEra);
  }).map((id) => {
    const eras = READINESS_ERAS[id] as readonly string[];
    return {
      id,
      ...READINESS_CATALOG[id],
      note:
        pinnedEra === undefined && eras.length === 1
          ? `${eras[0]} only`
          : undefined,
    };
  });
}

export const TASKS_ADVICE_CATALOG: CatalogEntry[] = MCP_TASKS_READINESS_IDS.map(
  (id) => ({ id, ...TASKS_READINESS_CATALOG[id] }),
);

export const OAUTH_ADVICE_CATALOG: CatalogEntry[] = MCP_OAUTH_READINESS_IDS.map(
  (id) => ({ id, ...OAUTH_READINESS_CATALOG[id] }),
);

export const APPS_CATALOG: CatalogEntry[] = MCP_APPS_CHECK_IDS.map((id) => ({
  id,
  ...APPS_CHECK_CATALOG[id],
}));

export const TASKS_CATALOG: CatalogEntry[] = MCP_TASKS_CHECK_IDS.map((id) => ({
  id,
  ...TASKS_CHECK_CATALOG[id],
}));

/**
 * The update acknowledgement check stays behind
 * `conformance-tasks-update-check` until its answers get a real form: today
 * they are raw JSON keyed by questions the server has not asked yet. `=== true`,
 * so a missing flag (or one PostHog has not hydrated yet) keeps it hidden.
 */
export const useTasksUpdateCheckEnabled = () =>
  useFeatureFlagEnabled("conformance-tasks-update-check") === true;

/** The Tasks checks a user can see and pick. */
export function shownTasksCatalog(updateCheck: boolean): CatalogEntry[] {
  return updateCheck
    ? TASKS_CATALOG
    : TASKS_CATALOG.filter((entry) => entry.id !== TASK_ANSWERS_CHECK);
}

/**
 * A runnable selection without the hidden check, so a saved pick of it (or
 * "the whole suite") does not run it. Apply after `runnableSelection`, which
 * maps the check's old id to this one.
 */
export function withoutHiddenTasksCheck(
  selection: ConformanceSelection | undefined,
  updateCheck: boolean,
): ConformanceSelection | undefined {
  if (updateCheck) return selection;
  return {
    ...selection,
    tasks: (selection?.tasks ?? MCP_TASKS_CHECK_IDS).filter(
      (id) => id !== TASK_ANSWERS_CHECK,
    ),
  };
}

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
