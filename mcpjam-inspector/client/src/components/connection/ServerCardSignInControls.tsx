import { Button } from "@mcpjam/design-system/button";

/** Shown while the card waits on a browser sign-in, so the wait can end. */
export function ServerCardCancelSignIn({
  serverName,
  onCancelSignIn,
}: {
  serverName: string;
  onCancelSignIn: (serverName: string) => void;
}) {
  return (
    <Button
      data-server-card-context-menu-exempt
      variant="ghost"
      size="sm"
      aria-label={`Cancel sign-in for ${serverName}`}
      onClick={() => onCancelSignIn(serverName)}
      className="h-6 px-2 text-[11px] cursor-pointer"
    >
      Cancel
    </Button>
  );
}
