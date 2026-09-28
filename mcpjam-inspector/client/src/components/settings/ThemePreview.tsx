function ProductSkeleton({ dark = false }: { dark?: boolean }) {
  return (
    <div className={dark ? "dark h-full" : "theme-preview-light h-full"}>
      <div className="flex h-full overflow-hidden bg-background text-foreground">
        <div className="w-1/4 space-y-2 border-r border-border bg-muted/40 p-2">
          <div className="mb-4 h-2 w-4/5 rounded-sm bg-foreground/30" />
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className={
                row === 1
                  ? "h-2 rounded-sm bg-primary/40"
                  : "h-2 rounded-sm bg-foreground/10"
              }
            />
          ))}
        </div>
        <div className="flex-1">
          <div className="flex h-6 items-center justify-between border-b border-border px-2">
            <div className="h-1.5 w-1/3 rounded-sm bg-foreground/20" />
            <div className="size-2 rounded-full bg-primary/40" />
          </div>
          <div className="space-y-2 p-3">
            <div className="h-2 w-1/2 rounded-sm bg-foreground/30" />
            <div className="h-1.5 w-3/4 rounded-sm bg-foreground/10" />
            <div className="grid grid-cols-2 gap-2 pt-2">
              {[0, 1, 2, 3].map((card) => (
                <div
                  key={card}
                  className="space-y-2 rounded border border-border p-2"
                >
                  <div className="size-3 rounded-sm bg-primary/30" />
                  <div className="h-1.5 w-4/5 rounded-sm bg-foreground/20" />
                  <div className="h-1 w-3/5 rounded-sm bg-foreground/10" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
export function ThemePreview({ mode }: { mode: "light" | "dark" | "system" }) {
  return (
    <div
      aria-hidden="true"
      className="relative h-36 overflow-hidden rounded-md border border-border"
    >
      <ProductSkeleton dark={mode === "dark"} />
      {mode === "system" && (
        <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
          <ProductSkeleton dark />
        </div>
      )}
    </div>
  );
}
