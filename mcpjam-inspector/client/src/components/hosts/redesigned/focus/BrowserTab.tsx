import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { Button } from "@mcpjam/design-system/button";
import { routePaths, useAppNavigate } from "@/lib/app-navigation";
import { Switch } from "@mcpjam/design-system/switch";
import { useBrowserEnabled } from "@/hooks/useComputersEnabled";
import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { BrowserRuntimeControls } from "@/components/browser/BrowserRuntimeControls";
import { BrowserProfilesSettings } from "@/components/browser/BrowserProfilesSettings";
import { BrowserProfilePicker } from "./BrowserProfilePicker";
import { FieldRow, FocusBlock } from "./primitives";

export function BrowserTab({
  projectId,
  draft,
  onDraftChange,
  readOnly = false,
}: {
  projectId?: string;
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  readOnly?: boolean;
}) {
  const navigate = useAppNavigate();
  const available = useBrowserEnabled();
  const locationOffered = useBrowserEngine(
    projectId ?? null,
    "preference",
  ).toggleVisible;
  const enabled = draft.builtInToolIds.includes("browser");
  return (
    <div className="flex flex-col gap-4">
      <FocusBlock
        title="This client"
        subtitle="Saved browser configuration for chats and environments using this client."
      >
        <FieldRow
          label="Browser"
          description="Let the agent use a browser. Local access requires your separate permission."
          control={
            <Switch
              aria-label="Browser"
              checked={enabled}
              disabled={readOnly || (!available && !enabled)}
              onCheckedChange={(checked) =>
                onDraftChange((prev) => ({
                  ...prev,
                  builtInToolIds: checked
                    ? [...new Set([...prev.builtInToolIds, "browser"])]
                    : prev.builtInToolIds.filter((id) => id !== "browser"),
                }))
              }
            />
          }
        />
        {(enabled || draft.browserProfileId) && (
          <FieldRow
            label="Browser profile"
            description="Choose a saved profile for this client. Without a selection, new chats use your default profile."
            control={
              <BrowserProfilePicker
                projectId={projectId}
                value={draft.browserProfileId}
                disabled={readOnly}
                onChange={(browserProfileId) =>
                  onDraftChange((prev) => ({ ...prev, browserProfileId }))
                }
              />
            }
          />
        )}
      </FocusBlock>
      {!readOnly && projectId && (
        <FocusBlock
          title="Your browser"
          subtitle={
            locationOffered
              ? "Your browser location, device permission and saved profiles. These do not change the client configuration."
              : "Your device permission and saved profiles. These do not change the client configuration."
          }
        >
          <BrowserRuntimeControls projectId={projectId} settings />
          <BrowserProfilesSettings projectId={projectId} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(routePaths.playground)}
          >
            Open Playground
          </Button>
        </FocusBlock>
      )}
    </div>
  );
}
