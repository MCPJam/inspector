import { RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  setMcpAppsOverridesOnDraft,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { stableStringifyJson } from "@/lib/client-config";
import type { McpAppsCapabilities } from "@/lib/client-styles";
import { toast } from "@/lib/toast";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { getTemplateMcpAppsCapabilities } from "@mcpjam/sdk/host-compat";

interface UpdateCapabilitiesButtonProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2
  ) => void;
}

function cloneCapabilities(
  capabilities: McpAppsCapabilities
): McpAppsCapabilities {
  return JSON.parse(JSON.stringify(capabilities)) as McpAppsCapabilities;
}

export function UpdateCapabilitiesButton({
  draft,
  onDraftChange,
}: UpdateCapabilitiesButtonProps) {
  const catalogState = useHostCatalog();
  const latest =
    catalogState.status === "live"
      ? getTemplateMcpAppsCapabilities(catalogState.catalog, draft.hostStyle)
      : undefined;
  const savedCapabilities = draft.mcpProfile?.apps?.mcpAppsOverrides;

  const alreadyCurrent =
    latest !== undefined &&
    savedCapabilities !== undefined &&
    draft.hostCapabilitiesOverride === undefined &&
    stableStringifyJson(savedCapabilities) === stableStringifyJson(latest);

  const disabled =
    catalogState.status !== "live" || latest === undefined || alreadyCurrent;

  const title =
    catalogState.status === "loading"
      ? "Loading live catalog"
      : catalogState.status !== "live"
      ? "Live catalog unavailable"
      : latest === undefined
      ? "No catalog capabilities for this host style"
      : alreadyCurrent
      ? "Capabilities already match the catalog"
      : "Update capabilities from catalog";

  const handleClick = () => {
    if (!latest || disabled) return;
    const next = cloneCapabilities(latest);
    onDraftChange((prev) =>
      setMcpAppsOverridesOnDraft(
        { ...prev, hostCapabilitiesOverride: undefined },
        next
      )
    );
    toast.success("Capabilities updated from catalog");
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      className="h-8 gap-1.5 px-2.5 text-[12px]"
    >
      <RefreshCw className="size-3.5" />
      <span>Update capabilities from catalog</span>
    </Button>
  );
}
