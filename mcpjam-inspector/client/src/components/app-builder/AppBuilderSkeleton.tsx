/**
 * Non-interactive skeleton that mimics the App Builder layout.
 * Rendered behind the welcome overlay to give visual context.
 */
export function AppBuilderSkeleton() {
  return (
    <div className="h-full flex">
      {/* Fake tools sidebar */}
      <div className="w-72 border-r bg-muted/20 p-4 space-y-4">
        <div className="h-3 w-20 bg-muted/60 rounded" />
        <div className="space-y-2">
          <div className="h-8 w-full bg-muted/40 rounded-md" />
          <div className="h-8 w-full bg-muted/40 rounded-md" />
          <div className="h-8 w-4/5 bg-muted/40 rounded-md" />
          <div className="h-8 w-full bg-muted/40 rounded-md" />
        </div>
        <div className="h-3 w-16 bg-muted/60 rounded mt-6" />
        <div className="space-y-2">
          <div className="h-8 w-full bg-muted/40 rounded-md" />
          <div className="h-8 w-3/5 bg-muted/40 rounded-md" />
        </div>
      </div>
      {/* Fake chat / preview area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 p-6 space-y-4">
          <div className="flex gap-3 items-start">
            <div className="h-8 w-8 rounded-full bg-muted/40 shrink-0" />
            <div className="space-y-2 flex-1">
              <div className="h-4 w-3/4 bg-muted/30 rounded" />
              <div className="h-4 w-1/2 bg-muted/30 rounded" />
            </div>
          </div>
          <div className="flex gap-3 items-start justify-end">
            <div className="space-y-2 flex-1 flex flex-col items-end">
              <div className="h-4 w-2/3 bg-muted/30 rounded" />
              <div className="h-4 w-1/3 bg-muted/30 rounded" />
            </div>
            <div className="h-8 w-8 rounded-full bg-muted/40 shrink-0" />
          </div>
        </div>
        <div className="p-4 border-t">
          <div className="h-12 w-full bg-muted/30 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
