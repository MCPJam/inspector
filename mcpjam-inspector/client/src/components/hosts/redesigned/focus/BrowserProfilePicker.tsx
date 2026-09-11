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

  if (!projectId) return null;

  const loading = profiles === null;
  const loaded = profiles ?? [];
  // A pin the list cannot explain keeps its own option: with no matching
  // <option>, React selects the FIRST one instead ("Default profile for my
  // chats"), so the control would contradict the pin the draft still carries.
  const unmatchedPin =
    value && !loaded.some((profile) => profile.profileId === value)
      ? value
      : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        disabled={disabled || loading}
        aria-label="Browser profile"
        className="h-8 w-64 rounded-md border bg-background px-2 text-xs text-foreground"
      >
        <option value="">Default profile for my chats</option>
        {unmatchedPin ? (
          <option value={unmatchedPin}>
            {loading ? "Loading…" : "Pinned profile (unavailable)"}
          </option>
        ) : null}
        {loaded.map((profile) => (
          <option key={profile.profileId} value={profile.profileId}>
            {profile.name}
          </option>
        ))}
      </select>
      <span className="text-right text-xs text-muted-foreground">
        {loading
          ? "Loading saved profiles…"
          : loaded.length === 0
            ? "No saved profiles yet — new chats use your default."
            : "Used by browser tools for this host"}
      </span>
    </div>
  );
}
