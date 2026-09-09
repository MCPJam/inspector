import { useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import {
  listBrowserProfiles,
  type BrowserProfile,
} from "@/lib/browser-profiles/client";

/** Select a saved profile pin for a host or leave it on the user's default. */
export function BrowserProfilePicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  projectId?: string;
  value?: string;
  onChange: (profileId: string | undefined) => void;
  disabled?: boolean;
}) {
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void listBrowserProfiles(projectId)
      .then((next) => {
        if (!cancelled) setProfiles(next);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not load saved browser profiles.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId || profiles === null || profiles.length === 0) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        disabled={disabled}
        aria-label="Browser profile"
        className="h-8 w-64 rounded-md border bg-background px-2 text-xs text-foreground"
      >
        <option value="">Default profile for my chats</option>
        {profiles.map((profile) => (
          <option key={profile.profileId} value={profile.profileId}>
            {profile.name}
          </option>
        ))}
      </select>
      <span className="text-right text-xs text-muted-foreground">
        Used by browser tools for this host
      </span>
    </div>
  );
}
