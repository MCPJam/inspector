/**
 * Header sparkle button that toggles the MCPJam Agent side panel.
 *
 * Gated behind the same `home-page-enabled` PostHog flag as the home-tab
 * takeover so the agent's entry points stay in sync. Renders nothing when
 * the flag is off (or still loading).
 */
import { useCallback } from "react";
import { Sparkles } from "lucide-react";
import { useFeatureFlagEnabled, usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useActiveTab } from "@/lib/app-navigation";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

const SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/.test(navigator.platform)
    ? "⌘\\"
    : "Ctrl+\\";

export function AgentSidePanelTrigger() {
  const homeEnabled = useFeatureFlagEnabled("home-page-enabled");
  const isOpen = useAgentPanelStore((s) => s.isOpen);
  const toggle = useAgentPanelStore((s) => s.toggle);
  const posthog = usePostHog();
  const activeTab = useActiveTab();

  const onClick = useCallback(() => {
    const next = !isOpen;
    if (next) {
      posthog?.capture("mcpjam_agent_panel_opened", {
        via: "click",
        tab: activeTab,
      });
    }
    toggle();
  }, [activeTab, isOpen, posthog, toggle]);

  if (!homeEnabled) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Ask MCPJam"
          aria-pressed={isOpen}
          onClick={onClick}
          className="h-9 w-9"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Ask MCPJam ({SHORTCUT_LABEL})
      </TooltipContent>
    </Tooltip>
  );
}
