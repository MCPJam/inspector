import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import evalSuiteEmptySrc from "../../assets/evals/eval-suite-empty.png";

const FIRST_SUITE_EMPTY_DESCRIPTION =
  "We generate cases from a server you already use, then keep running them in CI.";

/**
 * Every server gets a card. Past this many the hero switches to a denser
 * layout — smaller cards on a wider row, and a smaller illustration — so a
 * long list still reads as one block instead of a scrolling column.
 */
export const EVALS_EMPTY_HERO_DENSE_THRESHOLD = 6;

export type EvalsEmptyHeroServer = {
  id: string;
  name: string;
};

interface EvalsEmptyHeroProps {
  onCreateSuite: () => void;
  onEvalServer?: (server: EvalsEmptyHeroServer) => void;
  onQuickstart: () => void;
  isQuickstartRunning: boolean;
  showQuickstart: boolean;
  servers?: EvalsEmptyHeroServer[];
  serversLoading?: boolean;
}

export function EvalsEmptyHero({
  onCreateSuite,
  onEvalServer,
  onQuickstart,
  isQuickstartRunning,
  showQuickstart,
  servers = [],
  serversLoading = false,
}: EvalsEmptyHeroProps) {
  const showServerCards = servers.length > 0;
  const dense = servers.length > EVALS_EMPTY_HERO_DENSE_THRESHOLD;
  // Sample-suite lives down here because it has no other entry point. A
  // blank suite does: the header Create suite. Server cards open that
  // same form with the server and a name already filled in. Loading
  // withholds the row so it does not reflow when servers arrive.
  const showCtas = !serversLoading;
  // Without `onEvalServer` the card can only open the blank suite form, so it
  // must say so: a card that reads "Eval my server" and opens a blank form
  // promises a server-scoped start it cannot provide.
  const cardAction = onEvalServer ? "Eval my server" : "Create suite";

  return (
    // No `items-center` here: the child centers with `my-auto`, which keeps the
    // top reachable once a long server list makes the hero taller than the pane.
    <div
      className={cn(
        "flex min-h-0 flex-1 justify-center overflow-auto px-6",
        dense ? "py-6" : "py-10",
      )}
      data-testid="evals-empty-hero"
    >
      <div
        className={cn(
          "my-auto flex w-full flex-col items-center text-center",
          dense ? "max-w-3xl" : "max-w-xl",
        )}
      >
        <img
          src={evalSuiteEmptySrc}
          alt=""
          width={278}
          height={250}
          draggable={false}
          className={cn(
            "h-auto select-none",
            dense ? "mb-4 w-32" : "mb-6 w-48",
          )}
        />
        <h3 className="mb-2 text-xl font-semibold tracking-tight text-foreground">
          Automate the checks you'd run by hand
        </h3>
        <p className="text-sm text-muted-foreground">
          {FIRST_SUITE_EMPTY_DESCRIPTION}
        </p>

        {showServerCards ? (
          <div
            className={cn(
              "flex w-full flex-wrap items-center justify-center",
              dense ? "mt-4 gap-1.5" : "mt-6 gap-2",
            )}
          >
            {servers.map((server) => (
              <button
                key={server.id}
                type="button"
                aria-label={`${cardAction}: ${server.name}`}
                onClick={() =>
                  onEvalServer ? onEvalServer(server) : onCreateSuite()
                }
                className={cn(
                  "inline-flex max-w-full items-center rounded-md border border-border bg-background text-left shadow-xs transition-colors hover:bg-muted/40",
                  dense ? "gap-2 px-2 py-1" : "gap-3 px-3 py-2",
                )}
              >
                <span
                  className={cn(
                    "truncate font-semibold text-foreground",
                    dense ? "text-xs" : "text-sm",
                  )}
                >
                  {server.name}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-medium text-primary",
                    dense ? "text-xs" : "text-sm",
                  )}
                >
                  {cardAction}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {showCtas ? (
          <EmptyHeroCtas
            onCreateSuite={onCreateSuite}
            onQuickstart={onQuickstart}
            isQuickstartRunning={isQuickstartRunning}
            showQuickstart={showQuickstart}
            secondary={showServerCards}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * When server cards are up, only the sample suite stays here. Create suite
 * lives in the header. The cards open that form with the server prefilled.
 */
function EmptyHeroCtas({
  onCreateSuite,
  onQuickstart,
  isQuickstartRunning,
  showQuickstart,
  secondary,
}: {
  onCreateSuite: () => void;
  onQuickstart: () => void;
  isQuickstartRunning: boolean;
  showQuickstart: boolean;
  secondary: boolean;
}) {
  if (secondary) {
    if (!showQuickstart) {
      return null;
    }
    return (
      <div className="mt-4 flex flex-wrap items-center justify-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onQuickstart}
          disabled={isQuickstartRunning}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          {isQuickstartRunning ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          Try sample suite
        </Button>
      </div>
    );
  }

  if (!showQuickstart) {
    return (
      <div className="mt-6">
        <Button type="button" onClick={onCreateSuite}>
          Create suite
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-6 inline-flex overflow-hidden rounded-md shadow-xs">
      <Button
        type="button"
        onClick={onCreateSuite}
        className="rounded-none shadow-none"
      >
        Create suite
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={onQuickstart}
        disabled={isQuickstartRunning}
        className="gap-1.5 rounded-none border-l border-border shadow-none"
      >
        {isQuickstartRunning ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        Try sample suite
      </Button>
    </div>
  );
}
