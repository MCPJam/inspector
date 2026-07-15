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
