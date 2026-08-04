import { Inbox, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { ChatboxListItem } from "@/hooks/useChatboxes";
import {
  getChatboxHostLabel,
  getChatboxHostLogo,
} from "@/lib/chatbox-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

interface UserTestingOverviewProps {
  chatboxes: ChatboxListItem[];
  isLoading: boolean;
  onOpenTest: (namedHostId: string) => void;
  onCreateTest: () => void;
  /** Optional tester counts keyed by chatboxId (demo / future API). */
  testerCounts?: Record<string, number>;
}

export function UserTestingOverview({
  chatboxes,
  isLoading,
  onOpenTest,
  onCreateTest,
  testerCounts,
}: UserTestingOverviewProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  if (isLoading) {
    return (
      <div className="space-y-2 px-1 py-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-md border border-border/40 bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (chatboxes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <Inbox className="size-8 text-muted-foreground/70" />
        <h2 className="mt-4 text-base font-semibold">No prototypes yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Create a shareable prototype against your server, then watch real
          users try it in the client they already use.
        </p>
        <Button className="mt-5" onClick={onCreateTest}>
          <Plus className="mr-1.5 size-4" />
          Create new prototype
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_5rem] gap-3 border-b border-border/40 px-3 pb-2 text-xs font-medium text-muted-foreground">
        <span>Prototype</span>
        <span>Server</span>
        <span>Client</span>
        <span className="text-right">Testers</span>
      </div>
      <ul className="mt-1">
        {chatboxes.map((row) => {
          const logo = getChatboxHostLogo(row.hostStyle, undefined, themeMode);
          const clientLabel = getChatboxHostLabel(row.hostStyle);
          const serverLabel =
            row.serverNames[0] ??
            (row.serverCount > 0 ? `${row.serverCount} servers` : "—");
          const testerCount = testerCounts?.[row.chatboxId];
          return (
            <li key={row.chatboxId}>
              <button
                type="button"
                onClick={() => onOpenTest(row.namedHostId)}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_5rem] items-center gap-3 rounded-md border border-transparent px-3 py-3 text-left transition-colors",
                  "hover:border-border/60 hover:bg-muted/40",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {row.name}
                </span>
                <span className="min-w-0 truncate text-sm text-foreground">
                  {serverLabel}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background">
                    <img
                      src={logo}
                      alt=""
                      className="size-3.5 object-contain"
                    />
                  </span>
                  <span className="truncate text-sm text-foreground">
                    {clientLabel}
                  </span>
                </span>
                <span className="text-right text-sm tabular-nums text-foreground">
                  {testerCount ?? "—"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
