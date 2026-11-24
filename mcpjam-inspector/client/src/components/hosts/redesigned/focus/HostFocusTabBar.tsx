import { FocusTabBar } from "@/components/canvas-kit/FocusTabBar";
import type { HostFocusTabId } from "../types";
import {
  HOST_FOCUS_TAB_DEFS,
  type HostFocusTabDef,
} from "./host-focus-tab-defs";

interface HostFocusTabBarProps {
  tab: HostFocusTabId;
  onTabChange: (next: HostFocusTabId) => void;
  /**
   * Tabs to render. Defaults to the full static set; callers pass a filtered
   * list (e.g. from `useVisibleHostFocusTabs`) to hide conditional tabs like
   * the flag-gated Computer tab or the catalog-dependent Tools tab.
   */
  tabs?: ReadonlyArray<HostFocusTabDef>;
  className?: string;
}

export function HostFocusTabBar({
  tabs = HOST_FOCUS_TAB_DEFS,
  ...props
}: HostFocusTabBarProps) {
  return <FocusTabBar {...props} tabs={tabs} />;
}
