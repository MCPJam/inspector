import { useCallback, useState } from "react";
import { Check, ChevronDown, Loader2, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { toast } from "@/lib/toast";
import {
  deleteBrowserProfile,
  listBrowserProfiles,
  setBrowserProfileDefault,
  type BrowserProfile,
} from "@/lib/browser-profiles/client";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Project settings for saved browser profiles. */
export function BrowserProfilesSettings({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProfiles(await listBrowserProfiles(projectId));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not load browser profiles.",
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && profiles === null) void load();
  };

  const useForChats = async (profile: BrowserProfile) => {
    try {
      await setBrowserProfileDefault({
        projectId,
        profileId: profile.profileId,
      });
      setProfiles(
        (current) =>
          current?.map((entry) => ({
            ...entry,
            isDefaultForUser: entry.profileId === profile.profileId,
          })) ?? current,
      );
      toast.success(`“${profile.name}” will be used for new chats.`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not select that profile.",
      );
    }
  };

  const remove = async (profile: BrowserProfile) => {
    if (!window.confirm(`Delete the browser profile “${profile.name}”?`))
      return;
    try {
      await deleteBrowserProfile({ projectId, profileId: profile.profileId });
      setProfiles(
        (current) =>
          current?.filter((entry) => entry.profileId !== profile.profileId) ??
          current,
      );
      toast.success("Browser profile deleted.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not delete that profile.",
      );
    }
  };

  return (
    <section className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
        onClick={toggle}
        aria-expanded={open}
        data-testid="browser-profiles-toggle"
      >
        <span>Saved browser profiles</span>
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="border-t px-3 py-3">
          {loading ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading profiles…
            </span>
          ) : profiles?.length ? (
            <div className="space-y-2">
              {profiles.map((profile) => (
                <div
                  key={profile.profileId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{profile.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatBytes(profile.bytes)}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    {profile.isDefaultForUser ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3.5 w-3.5" />
                        Used for chats
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void useForChats(profile)}
                      >
                        Use for chats
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => void remove(profile)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No saved profiles yet. Save one from the browser panel while a
              persistent browser is running.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
