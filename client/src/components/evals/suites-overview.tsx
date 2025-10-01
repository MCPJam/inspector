import { formatTime } from "./helpers";
import { EvalSuite } from "./types";

interface SuitesOverviewProps {
  suites: EvalSuite[];
  onSelectSuite: (id: string) => void;
}

export function SuitesOverview({ suites, onSelectSuite }: SuitesOverviewProps) {
  if (suites.length === 0) {
    return (
      <div className="h-[calc(100vh-220px)] flex items-center justify-center rounded-xl border border-dashed">
        <div className="text-center space-y-2">
          <div className="text-lg font-semibold">No evaluation suites yet</div>
          <p className="text-sm text-muted-foreground">
            Trigger a test run to see your evaluation history here.
          </p>
        </div>
      </div>
    );
  }

  const sortedSuites = [...suites].sort(
    (a, b) => (b._creationTime || 0) - (a._creationTime || 0),
  );

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border">
        <div className="grid grid-cols-[minmax(0,1.2fr)_1fr] items-center gap-3 border-b bg-muted/50 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          <div>Test Suite</div>
          <div>Created</div>
        </div>
        <div className="divide-y">
          {sortedSuites.map((suite) => {
            const testCount = Array.isArray(suite.config?.tests)
              ? suite.config.tests.length
              : 0;

            return (
              <button
                key={suite._id}
                onClick={() => onSelectSuite(suite._id)}
                className="grid w-full grid-cols-[minmax(0,1.2fr)_1fr] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <div>
                  <div className="font-medium">
                    {new Date(suite._creationTime || 0).toLocaleDateString(
                      "en-US",
                      {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        hour12: true,
                      },
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {testCount} test{testCount !== 1 ? "s" : ""}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatTime(suite._creationTime)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
