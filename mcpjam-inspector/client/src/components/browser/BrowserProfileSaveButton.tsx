import { Loader2, Save } from "lucide-react";
import { useState } from "react";
import { DropdownMenuItem } from "@mcpjam/design-system/dropdown-menu";
import { toast } from "@/lib/toast";
import { saveBrowserProfile } from "@/lib/browser-profiles/client";

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

  const onSave = async () => {
    const name = window.prompt("Name this browser profile", "My browser");
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

  return (
    <DropdownMenuItem
      disabled={disabled || saving}
      onSelect={(event) => {
        event.preventDefault();
        void onSave();
      }}
      title={disabled ? "The browser is busy" : "Save this browser profile"}
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
