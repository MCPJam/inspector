import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import evalSuiteEmptySrc from "../../assets/evals/eval-suite-empty.png";

const FIRST_SUITE_EMPTY_DESCRIPTION =
  "Start from a server you've already connected.";

/** Keep the hero compact — more than this wraps awkwardly under the subtitle. */
export const EVALS_EMPTY_HERO_MAX_SERVERS = 4;

export type EvalsEmptyHeroServer = {
  id: string;
  name: string;
};

interface EvalsEmptyHeroProps {
  onCreateSuite: () => void;
  onCreateSuiteFromServer?: (server: EvalsEmptyHeroServer) => void;
  onQuickstart: () => void;
  isQuickstartRunning: boolean;
  showQuickstart: boolean;
  servers?: EvalsEmptyHeroServer[];
  serversLoading?: boolean;
}

export function EvalsEmptyHero({
  onCreateSuite,
  onCreateSuiteFromServer,
  onQuickstart,
  isQuickstartRunning,
  showQuickstart,
  servers = [],
  serversLoading = false,
}: EvalsEmptyHeroProps) {
  const visibleServers = servers.slice(0, EVALS_EMPTY_HERO_MAX_SERVERS);
  const showServerCards = visibleServers.length > 0;
  const showFallbackCtas = !serversLoading && visibleServers.length === 0;

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10"
      data-testid="evals-empty-hero"
    >
      <div className="my-auto flex w-full max-w-xl flex-col items-center text-center">
        <img
          src={evalSuiteEmptySrc}
          alt=""
          width={278}
          height={250}
          draggable={false}
          className="mb-6 h-auto w-48 select-none"
        />
        <h3 className="mb-2 text-xl font-semibold tracking-tight text-foreground">
          Create your first eval suite
        </h3>
        <p className="text-sm text-muted-foreground">
          {FIRST_SUITE_EMPTY_DESCRIPTION}
        </p>

        {showServerCards ? (
          <div className="mt-6 flex w-full flex-wrap items-center justify-center gap-2">
            {visibleServers.map((server) => (
              <button
                key={server.id}
                type="button"
                aria-label={`Create suite from ${server.name}`}
                onClick={() =>
                  onCreateSuiteFromServer
                    ? onCreateSuiteFromServer(server)
                    : onCreateSuite()
                }
                className="inline-flex max-w-full items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-muted/40"
              >
                <span className="truncate text-sm font-semibold text-foreground">
                  {server.name}
                </span>
                <span className="shrink-0 text-sm font-medium text-primary">
                  Create suite
                </span>
              </button>
            ))}
          </div>
        ) : showFallbackCtas ? (
          <EmptyHeroFallbackCtas
            onCreateSuite={onCreateSuite}
            onQuickstart={onQuickstart}
            isQuickstartRunning={isQuickstartRunning}
            showQuickstart={showQuickstart}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmptyHeroFallbackCtas({
  onCreateSuite,
  onQuickstart,
  isQuickstartRunning,
  showQuickstart,
}: {
  onCreateSuite: () => void;
  onQuickstart: () => void;
  isQuickstartRunning: boolean;
  showQuickstart: boolean;
}) {
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
