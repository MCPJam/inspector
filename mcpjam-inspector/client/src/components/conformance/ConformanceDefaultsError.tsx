import { Button } from "@mcpjam/design-system/button";
export function ConformanceDefaultsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 px-8 py-3 text-sm text-destructive"
    >
      Could not load the default checks and inputs.
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
