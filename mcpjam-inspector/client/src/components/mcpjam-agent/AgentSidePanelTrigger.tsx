/**
 * Header sparkle button that toggles the MCPJam Agent side panel.
 */
import { useCallback } from "react";
import { MessageCircle } from "lucide-react";
import { usePostHog } from "posthog-js/react";
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Ask MCPJam"
          aria-pressed={isOpen}
          onClick={onClick}
          className="h-9 gap-1.5 px-2.5"
        >
          <MessageCircle className="h-4 w-4" aria-hidden />
          <span>Ask MCPJam</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Ask MCPJam ({SHORTCUT_LABEL})
      </TooltipContent>
    </Tooltip>
  );
}
