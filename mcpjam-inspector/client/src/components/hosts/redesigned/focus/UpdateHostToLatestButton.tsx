import { useEffect, useRef, useState } from "react";
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
  hostId?: string;
  draft: HostConfigInputV2;
  savedDraft?: HostConfigInputV2;
  hostDisplayName: string;
  savedHostDisplayName?: string;
  onHostDisplayNameChange: (value: string) => void;
  themeMode: ThemeMode;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2
  ) => void;
  onSaveLatest: (
    name: string,
    draft: HostConfigInputV2
  ) => Promise<boolean>;
  hostLoaded: boolean;
  saveInFlight: boolean;
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
  hostId,
  draft,
  savedDraft = draft,
  hostDisplayName,
  savedHostDisplayName = hostDisplayName,
  onHostDisplayNameChange,
  themeMode,
  onDraftChange,
  onSaveLatest,
  hostLoaded,
  saveInFlight,
}: UpdateHostToLatestButtonProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const catalogState = useHostCatalog();
  const catalogHost =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, draft.hostStyle)
      : undefined;
  const catalogTemplate =
    catalogState.status === "live"
      ? getCatalogTemplate(catalogState.catalog, draft.hostStyle)
      : undefined;
  const savedCatalogHost =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, savedDraft.hostStyle)
      : undefined;
  const savedCatalogTemplate =
    catalogState.status === "live"
      ? getCatalogTemplate(catalogState.catalog, savedDraft.hostStyle)
      : undefined;
  const latestDraft =
    catalogTemplate === undefined
      ? undefined
      : applyCatalogTemplateToDraft(catalogTemplate, draft, themeMode);
  const latestSavedDraft =
    savedCatalogTemplate === undefined
      ? undefined
      : applyCatalogTemplateToDraft(
          savedCatalogTemplate,
          savedDraft,
          themeMode
        );
  const latestDisplayName = catalogHost?.label;
  const latestSavedDisplayName = savedCatalogHost?.label;

  const alreadyCurrent =
    latestDraft !== undefined &&
    latestDisplayName !== undefined &&
    hostDisplayName === latestDisplayName &&
    hostConfigInputsEqual(draft, latestDraft);
  const savedAlreadyCurrent =
    latestSavedDraft !== undefined &&
    latestSavedDisplayName !== undefined &&
    savedHostDisplayName === latestSavedDisplayName &&
    hostConfigInputsEqual(savedDraft, latestSavedDraft);
  const updateAvailable =
    catalogState.status === "live" &&
    draft.hostStyle === savedDraft.hostStyle &&
    catalogTemplate !== undefined &&
    latestDisplayName !== undefined &&
    latestSavedDraft !== undefined &&
    latestSavedDisplayName !== undefined &&
    !savedAlreadyCurrent &&
    !alreadyCurrent;
  const updateKey =
    catalogState.status === "live"
      ? `${hostId ?? "current-client"}:${savedDraft.hostStyle}:${catalogState.version}`
      : undefined;

  const disabled =
    isUpdating ||
    saveInFlight ||
    !hostLoaded ||
    catalogState.status !== "live" ||
    latestDraft === undefined ||
    alreadyCurrent;

  const title =
    isUpdating
      ? "Saving update"
      : catalogState.status === "loading"
      ? "Checking for updates"
      : catalogState.status !== "live"
      ? "Updates are unavailable right now"
      : latestDraft === undefined
      ? "No update available for this host"
      : alreadyCurrent
      ? "You're up to date"
      : "Update to latest";

  const handleClick = async () => {
    if (
      catalogTemplate === undefined ||
      latestDisplayName === undefined ||
      disabled
    ) {
      return;
    }
    const nextDraft = applyCatalogTemplateToDraft(
      catalogTemplate,
      draft,
      themeMode
    );
    onDraftChange(() => nextDraft);
    onHostDisplayNameChange(latestDisplayName);
    setIsUpdating(true);
    let saved = false;
    try {
      saved = await onSaveLatest(latestDisplayName, nextDraft);
    } finally {
      setIsUpdating(false);
    }
    if (saved) {
      toast.dismiss(UPDATE_TOAST_ID);
      toast.success("Updated to latest");
    }
  };

  // Keep the action pointed at the newest draft without re-showing the toast
  // on every local edit. Update availability is based on the saved client, so
  // changing a field in the editor does not look like a new catalog release.
  const handleClickRef = useRef(handleClick);
  handleClickRef.current = handleClick;
  const offeredUpdateKeyRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    const scheduleDismiss = () => {
      // Defer cleanup so React Strict Mode's setup/cleanup/setup replay can
      // cancel it instead of immediately hiding the toast in development.
      dismissTimerRef.current = setTimeout(() => {
        toast.dismiss(UPDATE_TOAST_ID);
        dismissTimerRef.current = null;
      }, 0);
    };
    if (!updateAvailable || updateKey === undefined) {
      toast.dismiss(UPDATE_TOAST_ID);
      return;
    }
    if (offeredUpdateKeyRef.current === updateKey) return scheduleDismiss;
    offeredUpdateKeyRef.current = updateKey;

    toast.info("Client update available", {
      id: UPDATE_TOAST_ID,
      description: `${latestDisplayName} has a newer configuration.`,
      duration: 10_000,
      action: {
        label: "Update to latest",
        onClick: () => void handleClickRef.current(),
      },
    });

    return scheduleDismiss;
  }, [latestDisplayName, updateAvailable, updateKey]);

  return (
    <Button
      type="button"
      size="sm"
      // `default` (the primary orange), not `outline`: this is the one
      // recommended action in a panel otherwise full of neutral controls, and
      // as an outline button it read as just another one of them.
      variant="default"
      onClick={() => void handleClick()}
      disabled={disabled}
      title={title}
      className="h-8 gap-1.5 px-2.5 text-[12px]"
    >
      <RefreshCw className="size-3.5" />
      <span>Update to latest</span>
    </Button>
  );
}
