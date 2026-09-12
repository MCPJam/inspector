import { Globe } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useAppNavigate } from "@/lib/app-navigation";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";

/** Opens this client's Browser tab in host focus. */
export function BrowserSettingsButton({ hostId }: { hostId: string }) {
  const navigate = useAppNavigate();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Browser settings"
      title="Open client Browser settings"
      data-testid="browser-settings-link"
      onClick={() => navigate(buildHostFocusTabPath(hostId, "browser"))}
    >
      <Globe className="h-3.5 w-3.5" />
    </Button>
  );
}
