export function UserSetupError() {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
      data-testid="user-setup-error"
    >
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold">Could not finish setup</h1>
        <p className="text-sm text-muted-foreground">
          We could not create your MCPJam user record. Refresh and try again.
        </p>
      </div>
      <button
        type="button"
        className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        onClick={() => window.location.reload()}
      >
        Refresh
      </button>
    </div>
  );
}
