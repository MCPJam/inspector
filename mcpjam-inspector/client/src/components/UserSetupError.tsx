import { Button } from "@mcpjam/design-system/button";

import { cn } from "@mcpjam/design-system/cn";

export function UserSetupError({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 p-6 text-center",
        className,
      )}
      data-testid="user-setup-error"
    >
      <h1 className="max-w-md text-xl font-semibold">
        Couldn’t finish setting up your account. Refresh to try again.
      </h1>
      <Button type="button" onClick={() => window.location.reload()}>
        Refresh
      </Button>
    </div>
  );
}
