/**
 * Non-interactive skeleton that mimics the App Builder layout.
 * Rendered behind the welcome overlay to give visual context.
 */
export function AppBuilderSkeleton() {
  return (
    <div className="h-full flex">
      {/* Fake tools sidebar */}
      <div className="w-72 border-r bg-muted/30 p-4 space-y-3">
        <div className="h-4 w-24 bg-muted rounded" />
        <div className="h-8 w-full bg-muted rounded" />
        <div className="h-8 w-full bg-muted rounded" />
        <div className="h-8 w-3/4 bg-muted rounded" />
        <div className="h-8 w-full bg-muted rounded" />
      </div>
      {/* Fake chat / preview area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1" />
        <div className="p-4">
          <div className="h-12 w-full bg-muted rounded-lg" />
        </div>
      </div>
    </div>
  );
}
