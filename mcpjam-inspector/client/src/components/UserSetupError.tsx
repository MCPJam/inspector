import { Button } from "@mcpjam/design-system/button";

export function UserSetupError({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-4 p-6 text-center ${className}`}
      data-testid="user-setup-error"
    >
      <h1 className="max-w-md text-xl font-semibold">
        Couldn’t finish setting up your account. Refresh to try again.
      </h1>
      <Button
        type="button"
        onClick={() => window.location.reload()}
      >
        Refresh
      </Button>
    </div>
  );
}
