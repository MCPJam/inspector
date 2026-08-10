import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  cloneHostTemplateInput,
  hostConfigInputsEqual,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { toast } from "@/lib/toast";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import type { ThemeMode } from "@/types/preferences/theme";

interface UpdateHostToLatestButtonProps {
  draft: HostConfigInputV2;
  savedDraft?: HostConfigInputV2;
  hostDisplayName: string;
  savedHostDisplayName?: string;
  onHostDisplayNameChange: (value: string) => void;
  themeMode: ThemeMode;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2
  ) => void;
}

const UPDATE_TOAST_ID = "client-update-available";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyCatalogTemplateToDraft(
  template: unknown,
  prev: HostConfigInputV2,
  themeMode: ThemeMode
): HostConfigInputV2 {
  const next = cloneHostTemplateInput(template, { themeMode });
  return {
    ...next,
    serverIds: [...prev.serverIds],
    optionalServerIds: [...prev.optionalServerIds],
    serverConnectionOverrides:
      prev.serverConnectionOverrides === undefined
        ? undefined
        : cloneJson(prev.serverConnectionOverrides),
  };
}

export function UpdateHostToLatestButton({
  draft,
  savedDraft = draft,
  hostDisplayName,
  savedHostDisplayName = hostDisplayName,
  onHostDisplayNameChange,
  themeMode,
  onDraftChange,
}: UpdateHostToLatestButtonProps) {
  const catalogState = useHostCatalog();
  const catalogHost =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, draft.hostStyle)
      : undefined;
  const catalogTemplate =
    catalogState.status === "live"
      ? getCatalogTemplate(catalogState.catalog, draft.hostStyle)
      : undefined;
  const latestDraft =
    catalogTemplate === undefined
      ? undefined
      : applyCatalogTemplateToDraft(catalogTemplate, draft, themeMode);
  const latestSavedDraft =
    catalogTemplate === undefined
      ? undefined
      : applyCatalogTemplateToDraft(catalogTemplate, savedDraft, themeMode);
  const latestDisplayName = catalogHost?.label;

  const alreadyCurrent =
    latestDraft !== undefined &&
    latestDisplayName !== undefined &&
    hostDisplayName === latestDisplayName &&
    hostConfigInputsEqual(draft, latestDraft);
  const savedAlreadyCurrent =
    latestSavedDraft !== undefined &&
    latestDisplayName !== undefined &&
    savedHostDisplayName === latestDisplayName &&
    hostConfigInputsEqual(savedDraft, latestSavedDraft);
  const updateAvailable =
    catalogState.status === "live" &&
    latestSavedDraft !== undefined &&
    latestDisplayName !== undefined &&
    !savedAlreadyCurrent &&
    !alreadyCurrent;

  const disabled =
    catalogState.status !== "live" ||
    latestDraft === undefined ||
    alreadyCurrent;

  const title =
    catalogState.status === "loading"
      ? "Checking for updates"
      : catalogState.status !== "live"
      ? "Updates are unavailable right now"
      : latestDraft === undefined
      ? "No update available for this host"
      : alreadyCurrent
      ? "You're up to date"
      : "Update to latest";

  const handleClick = () => {
    if (
      catalogTemplate === undefined ||
      latestDisplayName === undefined ||
      disabled
    ) {
      return;
    }
    onDraftChange((prev) =>
      applyCatalogTemplateToDraft(catalogTemplate, prev, themeMode)
    );
    onHostDisplayNameChange(latestDisplayName);
    toast.dismiss(UPDATE_TOAST_ID);
    toast.success("Updated to latest");
  };

  // Keep the action pointed at the newest draft without re-showing the toast
  // on every local edit. Update availability is based on the saved client, so
  // changing a field in the editor does not look like a new catalog release.
  const handleClickRef = useRef(handleClick);
  handleClickRef.current = handleClick;

  useEffect(() => {
    if (!updateAvailable) {
      toast.dismiss(UPDATE_TOAST_ID);
      return;
    }

    toast.info("Client update available", {
      id: UPDATE_TOAST_ID,
      description: `${latestDisplayName} has a newer configuration.`,
      duration: 10_000,
      action: {
        label: "Update to latest",
        onClick: () => handleClickRef.current(),
      },
    });

    return () => {
      toast.dismiss(UPDATE_TOAST_ID);
    };
  }, [latestDisplayName, updateAvailable]);

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
