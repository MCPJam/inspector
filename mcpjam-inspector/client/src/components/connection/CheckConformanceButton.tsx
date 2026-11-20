/**
 * "Check conformance" on a server card: opens Conformance and starts a run on
 * this server with its default checks, the same way a saved run's Run again
 * and the sidebar spotlight's "Check <server>" do.
 */
import { Button } from "@mcpjam/design-system/button";
import { MCPIcon } from "@/components/ui/mcp-icon";
import { track } from "@/lib/analytics";
import {
  buildConformanceRunServerPath,
  useAppNavigate,
} from "@/lib/app-navigation";

export function CheckConformanceButton({ serverName }: { serverName: string }) {
  const navigate = useAppNavigate();
  return (
    <Button
      variant="ghost"
      size="sm"
      // A click on the card opens its details; this one only checks.
      data-server-card-context-menu-exempt
      className="h-6 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
      onClick={(event) => {
        event.stopPropagation();
        track("check_conformance_clicked", {
          location: "server_connection_card",
        });
        navigate(buildConformanceRunServerPath(serverName));
      }}
    >
      {/* Its <title> would otherwise join the button's name. */}
      <MCPIcon aria-hidden className="size-3.5" />
      Check conformance
    </Button>
  );
}
