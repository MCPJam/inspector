import { buildHostsPath, routePaths } from "@/lib/app-navigation";
import type { HostFocusTabId } from "./redesigned/types";

export const HOST_VERIFY_TEMPLATE_PARAM = "template";
export const HOST_VERIFY_TAB_PARAM = "hostTab";

type HostVerifyTabParam =
  | "agent"
  | "tools"
  | "computer"
  | "protocol"
  | "apps"
  | "appearance";

const HOST_VERIFY_TAB_TO_FOCUS_TAB: Record<
  HostVerifyTabParam,
  HostFocusTabId
> = {
  agent: "behavior",
  tools: "tools",
  computer: "computer",
  protocol: "protocol",
  apps: "apps",
  appearance: "appearance",
};

const FOCUS_TAB_TO_HOST_VERIFY_TAB: Partial<
  Record<HostFocusTabId, HostVerifyTabParam>
> = {
  behavior: "agent",
  tools: "tools",
  computer: "computer",
  protocol: "protocol",
  apps: "apps",
  appearance: "appearance",
};

export function hostFocusTabToVerifyParam(
  tab: HostFocusTabId
): HostVerifyTabParam | null {
  return FOCUS_TAB_TO_HOST_VERIFY_TAB[tab] ?? null;
}

export function parseHostVerifyTabParam(search: string): HostFocusTabId | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search : `?${search}`
  );
  const raw = params.get(HOST_VERIFY_TAB_PARAM);
  if (!raw) return null;
  if (raw === "behavior") return "behavior";
  return raw in HOST_VERIFY_TAB_TO_FOCUS_TAB
    ? HOST_VERIFY_TAB_TO_FOCUS_TAB[raw as HostVerifyTabParam]
    : null;
}

/**
 * Path that opens a client straight on one of its focus tabs.
 *
 * `HostBuilderViewRedesigned` reads `?hostTab=` on every `location.search`
 * change and opens the focus panel there, so this is a plain link — no shared
 * state, and it survives a page load.
 *
 * `hostId` must be the Convex document id. The `:hostId` segment rejects
 * catalog slugs (`/hosts/chatgpt`), whose supported form is
 * `/hosts?template=chatgpt` — so callers without a saved client fall back to
 * the clients list, which is what `null` returns here.
 */
export function buildHostFocusTabPath(
  hostId: string | null | undefined,
  tab: HostFocusTabId
): string {
  const tabParam = hostFocusTabToVerifyParam(tab);
  if (!hostId) return routePaths.hosts;
  const path = buildHostsPath(hostId);
  if (!tabParam) return path;
  return `${path}?${new URLSearchParams({
    [HOST_VERIFY_TAB_PARAM]: tabParam,
  }).toString()}`;
}

export function buildHostVerifySearch(
  templateId: string,
  tab: HostFocusTabId = "behavior"
): string {
  const params = new URLSearchParams({
    [HOST_VERIFY_TEMPLATE_PARAM]: templateId,
  });
  const tabParam = hostFocusTabToVerifyParam(tab);
  if (tabParam) params.set(HOST_VERIFY_TAB_PARAM, tabParam);
  return params.toString();
}
