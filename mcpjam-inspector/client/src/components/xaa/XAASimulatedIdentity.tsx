import { User } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { useXaaRunSettings } from "@/hooks/useXaaRunSettings";

interface XAASimulatedIdentityProps {
  /** When true, the trigger collapses to an icon-only button (mobile). */
  iconOnly?: boolean;
}

// Run-bar control for the global simulated identity (sub + email). The
// MCPJam IdP mints a mock ID token for this user before exchanging it for an
// ID-JAG. A dot on the trigger signals a non-default identity — preserving the
// "you have a custom identity" cue the old auto-opening config modal gave.
export function XAASimulatedIdentity({
  iconOnly = false,
}: XAASimulatedIdentityProps) {
  const { userId, email, isDefaultIdentity, setIdentity } = useXaaRunSettings();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="relative shrink-0"
          aria-label="Edit simulated identity"
        >
          <User className="h-3.5 w-3.5" />
          {iconOnly ? null : <span>Identity</span>}
          {!isDefaultIdentity ? (
            <span
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Simulated identity</p>
          <p className="text-xs text-muted-foreground">
            The MCPJam issuer mints a mock ID token for this user, then
            exchanges it for an ID-JAG. Applies to every target.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="xaa-identity-sub">Subject (sub)</Label>
          <Input
            id="xaa-identity-sub"
            value={userId}
            onChange={(event) => setIdentity({ userId: event.target.value })}
            placeholder="user-12345"
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="xaa-identity-email">Email</Label>
          <Input
            id="xaa-identity-email"
            value={email}
            onChange={(event) => setIdentity({ email: event.target.value })}
            placeholder="demo.user@example.com"
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
