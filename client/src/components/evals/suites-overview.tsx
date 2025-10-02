import type { EvalSuite } from "./types";
import { SuiteRow } from "./SuiteRow";

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
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.8fr)] items-center gap-3 border-b bg-muted/50 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          <div>Test Suite</div>
          <div>Status</div>
          <div>Created</div>
        </div>
        <div className="divide-y">
          {sortedSuites.map((suite) => (
            <SuiteRow
              key={suite._id}
              suite={suite}
              onSelectSuite={onSelectSuite}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
