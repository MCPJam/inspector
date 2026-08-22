import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import type { ScenarioListItem } from "@/hooks/useScenarios";
import {
  getScenarioHostLabel,
  getScenarioHostLogo,
} from "@/lib/scenario-client-style";
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
  scenarios: ScenarioListItem[] | undefined;
  isLoading: boolean;
  /** Receives the scenario's scenario id — the route's `:scenarioId`. */
  onOpenScenario: (scenarioId: string) => void;
  onCreateScenario: () => void;
  createLabel: string;
}

// One pad shared by the header and every row, so the columns can't drift apart.
const ROW_PAD = "grid w-full items-center gap-4 px-3";
const ROW_COLS =
  "grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_7rem]";

export function UserTestingOverviewPanel(props: UserTestingOverviewPanelProps) {
  return (
    // Catches a render failure in the rows — a row shaped differently than
    // this component expects. It does NOT cover the list query: that runs in
    // the parent, above this boundary. The fallback says the list failed
    // rather than reusing the empty state, because "we couldn't show your
    // scenarios" and "you have no scenarios" send a user to different places.
    <ErrorBoundary
      fallback={
        <LoadFailureState
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
  scenarios,
  isLoading,
  onOpenScenario,
  onCreateScenario,
  createLabel,
}: UserTestingOverviewPanelProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);

  if (isLoading) {
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

  // Not loading and no rows — including the skipped-query case, where the hook
  // reports `isLoading: false` with no data because there is no project or no
  // auth to query with. Treating that as "still loading" would spin forever.
  if (!scenarios || scenarios.length === 0) {
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
        {scenarios.map((row) => (
          <li key={row.scenarioId}>
            <button
              type="button"
              data-testid="user-testing-overview-row"
              data-scenario-id={row.scenarioId}
              data-host-id={row.namedHostId}
              onClick={() => onOpenScenario(row.scenarioId)}
              className={cn(
                ROW_PAD,
                ROW_COLS,
                "rounded-md border border-transparent py-3 text-left transition-colors",
                "hover:border-border/60 hover:bg-muted/40",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {row.name}
                </span>
                {row.environmentError ? (
                  // The row is deliberately still here — its share link is
                  // minted and only its owner can retire it — so say what's
                  // wrong instead of rendering a confident, empty-looking row.
                  <AlertTriangle
                    data-testid="user-testing-overview-row-error"
                    aria-label={row.environmentError.message}
                    className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500"
                  />
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background">
                  <img
                    src={getScenarioHostLogo(
                      row.hostStyle,
                      undefined,
                      themeMode,
                    )}
                    alt=""
                    className="size-3.5 object-contain"
                  />
                </span>
                <span className="truncate text-sm text-foreground">
                  {getScenarioHostLabel(row.hostStyle)}
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

function serverLabel(row: ScenarioListItem): string {
  // Tolerate a row without the array: a version skew should cost this cell,
  // not the whole list.
  const names = row.serverNames ?? [];
  if (names.length > 0) return names[0];
  return row.serverCount > 0 ? `${row.serverCount} servers` : "—";
}

function LoadFailureState({
  onCreateScenario,
  createLabel,
}: {
  onCreateScenario: () => void;
  createLabel: string;
}) {
  return (
    <div
      className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
      data-testid="user-testing-overview-error"
    >
      <AlertTriangle className="size-8 text-amber-500" />
      <h2 className="mt-4 text-base font-semibold">
        Couldn&apos;t show your scenarios
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        The list failed to render. Reload the page — this doesn&apos;t mean
        anything happened to your scenarios.
      </p>
      <Button variant="outline" className="mt-5" onClick={onCreateScenario}>
        <Plus className="mr-1.5 size-4" />
        {createLabel}
      </Button>
    </div>
  );
}

/**
 * The redesigned User Testing empty state (BB-125).
 *
 * The graphic is one of the project's pixel characters rather than the frame's
 * bitmap: the asset lives in the design file, and reaching for a stock icon
 * instead would put a third visual language on a page that already sits beside
 * the Swarm empty state. Scaled up because at its native 44px it reads as a
 * list bullet, not an illustration.
 *
 * The scale goes on a WRAPPER so it stays independent of the avatar, which
 * animates its own `transform` for the idle float every PersonaPixelAvatar
 * carries. Tailwind emits the standalone `scale` property, so the two do
 * compose today — the wrapper is what keeps that true if the utility ever
 * compiles to `transform` instead, where the animation would win.
 */
function EmptyState({
  onCreateScenario,
  createLabel,
}: {
  onCreateScenario: () => void;
  createLabel: string;
}) {
  return (
    <div
      className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
      data-testid="user-testing-overview-empty"
    >
      <div
        className="flex h-[120px] w-[88px] items-end justify-center"
        data-testid="user-testing-empty-illustration"
      >
        {/* origin-bottom so the scale grows upward from the character's feet
            and the row keeps its baseline. */}
        <span className="origin-bottom scale-[2]">
          <PersonaPixelAvatar
            seed="user-testing-empty-state"
            shapeIndex={1}
            paletteIndex={5}
            size="lg"
          />
        </span>
      </div>
      <h2 className="mt-4 text-lg font-semibold">Create your first study</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-foreground">
        A study starts with a link you send. Users open it, use your server
        inside the client they&rsquo;re used to seeing, and their sessions are
        recorded here.
      </p>
      <Button size="sm" className="mt-4" onClick={onCreateScenario}>
        <Plus className="mr-1.5 size-4" />
        {createLabel}
      </Button>
    </div>
  );
}
