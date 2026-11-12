/**
 * Notices shown inside first-run onboarding: a refused guest session and a
 * failed connection. Both use the design-system Alert.
 */
import { AlertCircle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import type { GuestSessionRefusalReason } from "@/lib/guest-session";
import { guestSessionRefusalCopy } from "@/lib/guest-session-refusal-copy";

export function GuestSessionRefusalNotice({
  reason,
  onSignIn,
}: {
  reason: GuestSessionRefusalReason;
  onSignIn?: () => void;
}) {
  const copy = guestSessionRefusalCopy(reason);
  return (
    <Alert variant="warning" className="mt-8 px-5 py-4 text-base">
      <AlertCircle className="text-warning" aria-hidden />
      <AlertTitle className="line-clamp-none">{copy.title}</AlertTitle>
      <AlertDescription className="text-sm leading-relaxed text-muted-foreground">
        <p>{copy.detail}</p>
        <Button type="button" className="mt-3" onClick={onSignIn}>
          Sign in
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The raw error stays visible: the people connecting servers here debug them. */
export function ConnectionFailureNotice({
  title,
  error,
}: {
  title: string;
  error: string;
}) {
  return (
    <Alert variant="destructive" className="mt-6 px-5 py-4 text-base">
      <AlertCircle aria-hidden />
      <AlertTitle className="line-clamp-none text-foreground">
        {title}
      </AlertTitle>
      <AlertDescription>
        <pre className="mt-2 w-full overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
          {error}
        </pre>
      </AlertDescription>
    </Alert>
  );
}
