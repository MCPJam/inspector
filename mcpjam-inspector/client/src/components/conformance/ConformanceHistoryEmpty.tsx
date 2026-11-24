/**
 * What History shows when it has no runs to list: the page's empty state,
 * the one Overview shows before the first run, with History's own words and
 * actions for each case (no runs yet, a server with none, a search with no
 * matches).
 */
import { Button } from "@mcpjam/design-system/button";
import { ConformanceEmptyPrompt, RUN_LABEL } from "./ConformancePageChrome";
import { useConformanceRunRequest } from "./conformance-run-request";

export function ConformanceHistoryEmpty({
  title,
  description,
  clear,
}: {
  title: string;
  description: string;
  /** A way back to every run, when a filter or search caused the empty list. */
  clear?: { label: string; onClear: () => void };
}) {
  const runRequest = useConformanceRunRequest();
  return (
    <div
      className="flex grow flex-col"
      role="status"
      data-testid="conformance-history-empty"
    >
      <ConformanceEmptyPrompt title={title} description={description}>
        {clear ? (
          <Button variant="outline" size="sm" onClick={clear.onClear}>
            {clear.label}
          </Button>
        ) : null}
        {runRequest ? (
          <Button
            size="sm"
            onClick={runRequest.run}
            disabled={runRequest.disabled}
          >
            {RUN_LABEL}
          </Button>
        ) : null}
      </ConformanceEmptyPrompt>
    </div>
  );
}
