/** The handoff page's frame, and the indicator it shows while it works. */

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">{children}</div>
    </div>
  );
}

export function Spinner() {
  return (
    <div
      className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      role="status"
      aria-label="Working"
    />
  );
}
