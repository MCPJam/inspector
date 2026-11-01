import { Loader2, Save } from "lucide-react";
import { useState } from "react";
import { DropdownMenuItem } from "@mcpjam/design-system/dropdown-menu";
import { toast } from "@/lib/toast";
import { saveBrowserProfile } from "@/lib/browser-profiles/client";
import { useBrowserProfileArchivesAvailable } from "@/lib/browser-profiles/availability";

// The archive carries live cookies, so the user decides with that in view.
const SAVE_PROFILE_PROMPT = [
  "Name this browser profile.",
  "Chats that use this profile act as you on the sites this browser visited. Delete the profile in Settings to remove access.",
].join("\n\n");

// Mirrors the exclusions in browserd's profile-archive.ts.
const SAVE_PROFILE_HINT =
  "Saved passwords, autofill and history are left out of the profile.";

export interface BrowserProfileArchiveResult {
  archive: Blob;
  savedFrom?: string;
}

/** Save the currently running persistent browser as a reusable profile. */
export function BrowserProfileSaveButton({
  projectId,
  exportArchive,
  disabled = false,
}: {
  projectId: string;
  exportArchive: () => Promise<BrowserProfileArchiveResult>;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const available = useBrowserProfileArchivesAvailable();

  const onSave = async () => {
    const name = window.prompt(SAVE_PROFILE_PROMPT, "My browser");
    if (!name?.trim()) return;
    setSaving(true);
    try {
      const result = await exportArchive();
      if (!result.savedFrom) {
        throw new Error("This browser is not attached to a chat session yet.");
      }
      await saveBrowserProfile({
        projectId,
        name: name.trim(),
        savedFrom: result.savedFrom,
        archive: result.archive,
      });
      toast.success(`Saved browser profile “${name.trim()}”.`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save the browser profile.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (!available) {
    return (
      <DropdownMenuItem disabled>
        <Save className="h-3.5 w-3.5" />
        <span className="flex flex-col">
          Save profile for other chats…
          <span className="text-xs text-muted-foreground">
            Not available on this server
          </span>
        </span>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      disabled={disabled || saving}
      onSelect={(event) => {
        event.preventDefault();
        void onSave();
      }}
      title={disabled ? "The browser is busy" : SAVE_PROFILE_HINT}
    >
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Save className="h-3.5 w-3.5" />
      )}
      {saving ? "Saving profile…" : "Save profile for other chats…"}
    </DropdownMenuItem>
  );
}
