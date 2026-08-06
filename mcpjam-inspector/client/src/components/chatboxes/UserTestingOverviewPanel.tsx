import { formatDistanceToNow } from "date-fns";
import { Inbox, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import type { ChatboxListItem } from "@/hooks/useChatboxes";
import {
  getChatboxHostLabel,
  getChatboxHostLogo,
} from "@/lib/chatbox-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

/**
 * The project's User Testing scenarios, newest activity first.
 *
 * Rows are passed in rather than queried here: the parent already subscribes to
 * the same list for the agent snapshot and the delete command, and two
 * subscriptions to one query is two chances to disagree.
 *
 * Absent is not zero. `uniqueTesterCount` and `lastSessionAt` are optional on
 * the wire — a deployment that predates the counters renders "—", because "no
 * testers yet" and "we don't know yet" are different claims and only one of
 * them should make someone go looking for a bug.
 */
interface UserTestingOverviewPanelProps {
  /** Undefined while loading (Convex `useQuery` semantics). */
  chatboxes: ChatboxListItem[] | undefined;
  isLoading: boolean;
  onOpenScenario: (hostId: string) => void;
  onCreateScenario: () => void;
  createLabel: string;
}

// One pad shared by the header and every row, so the columns can't drift apart.
const ROW_PAD = "grid w-full items-center gap-4 px-3";
const ROW_COLS =
  "grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_7rem]";

export function UserTestingOverviewPanel(props: UserTestingOverviewPanelProps) {
  return (
    // A Convex query against a backend that hasn't deployed the counters yet
    // THROWS out of `useQuery` rather than returning undefined, and an
    // uncaught throw here takes the whole screen. Falling back to the empty
    // state keeps the create path reachable.
    <ErrorBoundary
      fallback={
        <EmptyState
          onCreateScenario={props.onCreateScenario}
          createLabel={props.createLabel}
        />
      }
    >
      <OverviewBody {...props} />
    </ErrorBoundary>
  );
}

function OverviewBody({
  chatboxes,
  isLoading,
  onOpenScenario,
  onCreateScenario,
  createLabel,
}: UserTestingOverviewPanelProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  if (isLoading || chatboxes === undefined) {
    return (
      <div className="space-y-2" data-testid="user-testing-overview-loading">
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
      <EmptyState
        onCreateScenario={onCreateScenario}
        createLabel={createLabel}
      />
    );
  }

  return (
    <div className="min-w-0" data-testid="user-testing-overview">
      <div
        className={cn(
          ROW_PAD,
          ROW_COLS,
          "border-b border-border/40 pb-2 text-xs font-medium text-muted-foreground",
        )}
      >
        <span>Scenario</span>
        <span>Client</span>
        <span>Server</span>
        <span className="text-right">Testers</span>
        <span className="text-right">Last session</span>
      </div>
      <ul className="mt-1">
        {chatboxes.map((row) => (
          <li key={row.chatboxId}>
            <button
              type="button"
              data-testid="user-testing-overview-row"
              data-host-id={row.namedHostId}
              onClick={() => onOpenScenario(row.namedHostId)}
              className={cn(
                ROW_PAD,
                ROW_COLS,
                "rounded-md border border-transparent py-3 text-left transition-colors",
                "hover:border-border/60 hover:bg-muted/40",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {row.name}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background">
                  <img
                    src={getChatboxHostLogo(
                      row.hostStyle,
                      undefined,
                      themeMode,
                    )}
                    alt=""
                    className="size-3.5 object-contain"
                  />
                </span>
                <span className="truncate text-sm text-foreground">
                  {getChatboxHostLabel(row.hostStyle)}
                </span>
              </span>
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {serverLabel(row)}
              </span>
              <span
                data-testid="user-testing-overview-testers"
                className="text-right text-sm tabular-nums text-foreground"
              >
                {row.uniqueTesterCount ?? "—"}
              </span>
              <span className="truncate text-right text-sm text-muted-foreground">
                {row.lastSessionAt
                  ? formatDistanceToNow(row.lastSessionAt, { addSuffix: true })
                  : "—"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function serverLabel(row: ChatboxListItem): string {
  if (row.serverNames.length > 0) return row.serverNames[0];
  return row.serverCount > 0 ? `${row.serverCount} servers` : "—";
}

function EmptyState({
  onCreateScenario,
  createLabel,
}: {
  onCreateScenario: () => void;
  createLabel: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center px-6 py-16 text-center"
      data-testid="user-testing-overview-empty"
    >
      <Inbox className="size-8 text-muted-foreground/70" />
      <h2 className="mt-4 text-base font-semibold">No scenarios yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        A scenario is one client pointed at one of your servers, behind a link
        you can hand to a real person. Every client you set up in Connect is
        published as one.
      </p>
      <Button className="mt-5" onClick={onCreateScenario}>
        <Plus className="mr-1.5 size-4" />
        {createLabel}
      </Button>
    </div>
  );
}
