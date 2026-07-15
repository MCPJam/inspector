/** Centered message box used by the terminal-pane state machines. */
export function PaneMessage({
  children,
  dashed = false,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-3 rounded-md border text-sm text-muted-foreground ${
        dashed ? "border-dashed bg-muted/10" : "bg-muted/20"
      }`}
    >
      {children}
    </div>
  );
}
