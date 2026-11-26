import { useCallback } from "react";
import { useSearchParams } from "react-router";
import type { ServerDetailTab } from "@/components/connection/hooks/use-server-detail-controller";

/*
 * `/servers/:serverId?serverTab=…&feature=…`: the right-hand tab and the
 * selected feature or family live in the URL, so both survive a reload and
 * move with Back and Forward. Each change pushes a history entry.
 */

export const SERVER_TAB_PARAM = "serverTab";
export const FEATURE_PARAM = "feature";

const TAB_BY_PARAM = {
  config: "configuration",
  overview: "overview",
  tools: "tools-metadata",
  settings: "settings",
  auth: "authorization",
  clients: "compatibility",
  history: "history",
} as const satisfies Record<string, ServerDetailTab>;

type ServerTabParam = keyof typeof TAB_BY_PARAM;

const PARAM_BY_TAB = Object.fromEntries(
  Object.entries(TAB_BY_PARAM).map(([param, tab]) => [tab, param]),
) as Record<ServerDetailTab, ServerTabParam>;

function isServerTabParam(value: string): value is ServerTabParam {
  return Object.prototype.hasOwnProperty.call(TAB_BY_PARAM, value);
}

/** The tab a `serverTab` value names; Config for none or an unknown one. */
export function serverTabFromParam(value: string | null): ServerDetailTab {
  return value && isServerTabParam(value) ? TAB_BY_PARAM[value] : "configuration";
}

export function serverTabParam(tab: ServerDetailTab): string {
  return PARAM_BY_TAB[tab];
}

/** The search string for opening a server page on `tab`, or "" for Config. */
export function serverTabSearch(tab: ServerDetailTab): string {
  return tab === "configuration"
    ? ""
    : `?${new URLSearchParams({ [SERVER_TAB_PARAM]: serverTabParam(tab) })}`;
}

export function useServerCanvasUrlState(): {
  tab: ServerDetailTab;
  setTab: (tab: ServerDetailTab) => void;
  /** Raw `feature` value; the page ignores ids the catalog does not know. */
  featureId: string | null;
  setFeature: (id: string | null) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const update = useCallback(
    (key: string, value: string | null) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      });
    },
    [setSearchParams],
  );
  const setTab = useCallback(
    (tab: ServerDetailTab) =>
      update(SERVER_TAB_PARAM, tab === "configuration" ? null : serverTabParam(tab)),
    [update],
  );
  const setFeature = useCallback(
    (id: string | null) => update(FEATURE_PARAM, id),
    [update],
  );
  return {
    tab: serverTabFromParam(searchParams.get(SERVER_TAB_PARAM)),
    setTab,
    featureId: searchParams.get(FEATURE_PARAM),
    setFeature,
  };
}
