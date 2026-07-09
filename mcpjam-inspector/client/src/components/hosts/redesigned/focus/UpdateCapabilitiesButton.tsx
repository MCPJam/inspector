import { RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { type HostConfigInputV2 } from "@/lib/client-config-v2";
import { stableStringifyJson } from "@/lib/client-config";
import { toast } from "@/lib/toast";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import {
  getCatalogHost,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";

interface UpdateCapabilitiesButtonProps {
  hostDisplayName: string;
  onHostDisplayNameChange: (value: string) => void;
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2
  ) => void;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function UpdateCapabilitiesButton({
  hostDisplayName,
  onHostDisplayNameChange,
  draft,
  onDraftChange,
}: UpdateCapabilitiesButtonProps) {
  const catalogState = useHostCatalog();
  const catalogHost =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, draft.hostStyle)
      : undefined;
  const latestTemplate =
    catalogState.status === "live"
      ? getCatalogTemplate(catalogState.catalog, draft.hostStyle)
      : undefined;

  const alreadyCurrent =
    latestTemplate !== undefined &&
    catalogHost !== undefined &&
    hostDisplayName === catalogHost.label &&
    stableStringifyJson(draft) === stableStringifyJson(latestTemplate);

  const disabled =
    catalogState.status !== "live" ||
    latestTemplate === undefined ||
    catalogHost === undefined ||
    alreadyCurrent;

  const title =
    catalogState.status === "loading"
      ? "Checking for updates"
      : catalogState.status !== "live"
      ? "Updates are unavailable right now"
      : latestTemplate === undefined || catalogHost === undefined
      ? "No update available for this host"
      : alreadyCurrent
      ? "You're up to date"
      : "Update to latest";

  const handleClick = () => {
    if (!latestTemplate || !catalogHost || disabled) return;
    onDraftChange(() => cloneJson(latestTemplate) as HostConfigInputV2);
    onHostDisplayNameChange(catalogHost.label);
    toast.success("Updated to latest");
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
      <span>Update to latest</span>
    </Button>
  );
}
