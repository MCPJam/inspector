import { useEffect, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, LogIn } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  connectAuthChallenge,
  dismissAuthChallenge,
  useAuthChallengeCards,
  type AuthChallengeCard as AuthChallengeCardModel,
  type AuthChallengeConnectResult,
  type AuthChallengeSurface,
} from "@/lib/auth-challenge-lifecycle";
import type { ServerWithName } from "@/state/app-types";

function operationPhrase(card: AuthChallengeCardModel): string {
  switch (card.operation.method) {
    case "resources/read":
      return `to read ${card.operation.operation}`;
    case "prompts/get":
      return `to use the prompt ${card.operation.operation}`;
    default:
      return `to use ${card.operation.operation}`;
  }
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export type AuthChallengeCardProps = {
  card: AuthChallengeCardModel;
  server: ServerWithName | undefined;
  /** Told what a Connect click led to, when it did not leave the page. */
  onResult?: (result: AuthChallengeConnectResult) => void;
  className?: string;
};

/**
 * "‹Server› (‹origin›) needs you to sign in to use ‹tool›. [Connect] [Not now]"
 *
 * Every string from the server is rendered as text. The card names only the
 * MCP server's origin: the authorization server is not fetched before the
 * user clicks, and its own consent page names itself.
 */
export function AuthChallengeCard({
  card,
  server,
  onResult,
  className,
}: AuthChallengeCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const now = useNow(true);
  const remaining = card.expiresAt - now;
  const expired = remaining <= 0;

  const handleConnect = async (event: MouseEvent<HTMLButtonElement>) => {
    setConnecting(true);
    try {
      const result = await connectAuthChallenge(card, server, {
        // Only a real user gesture may send the browser to an authorization
        // server; a scripted `.click()` is not trusted.
        isTrusted: event.nativeEvent.isTrusted,
      });
      onResult?.(result);
    } finally {
      setConnecting(false);
    }
  };

  const followUp = expired
    ? "This request expired. Sign in, then run it again."
    : card.action === "notify"
      ? "After you sign in, run it again."
      : card.readOnly
        ? `It runs again after you sign in. Expires in ${formatRemaining(remaining)}.`
        : `After you sign in, you'll be asked before it runs again. Expires in ${formatRemaining(remaining)}.`;

  const scope = card.signal.requiredScope;
  const description = card.signal.errorDescription;

  return (
    <div
      role="region"
      aria-label={`Sign in to ${card.serverName}`}
      data-testid="auth-challenge-card"
      className={cn(
        "rounded-lg border border-border border-l-2 border-l-primary bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <LogIn className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium break-words">
            {card.serverName}
            {card.serverOrigin ? ` (${card.serverOrigin})` : ""} needs you to
            sign in {operationPhrase(card)}.
          </p>
          <p className="text-xs text-muted-foreground">{followUp}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
        <Button
          size="sm"
          onClick={handleConnect}
          disabled={connecting || !server}
        >
          Connect
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => dismissAuthChallenge(card)}
          disabled={connecting}
        >
          Not now
        </Button>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          Details
        </button>
      </div>
      {detailsOpen ? (
        <dl
          className="mt-3 space-y-2 border-t border-border pt-3 pl-7 text-xs"
          data-testid="auth-challenge-details"
        >
          {scope ? (
            <div>
              <dt className="text-muted-foreground">Requested scope</dt>
              <dd className="font-mono break-all">{scope}</dd>
            </div>
          ) : null}
          {description ? (
            <div>
              <dt className="text-muted-foreground">Server message</dt>
              <dd className="break-words">{description}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">How the host handles it</dt>
            <dd className="break-words">{card.explanation}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/** Every visible card for one surface and server. */
export function AuthChallengeCards({
  surface,
  server,
  onResult,
  className,
}: {
  surface: AuthChallengeSurface;
  server: ServerWithName | undefined;
  onResult?: (result: AuthChallengeConnectResult) => void;
  className?: string;
}) {
  const cards = useAuthChallengeCards(surface, server?.name);
  if (!server || cards.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {cards.map((card) => (
        <AuthChallengeCard
          key={card.key}
          card={card}
          server={server}
          onResult={onResult}
        />
      ))}
    </div>
  );
}

/**
 * Every visible card for one surface, across servers (the Playground rail
 * lists tools from several). Each card resolves its own server.
 */
export function AuthChallengeCardsForSurface({
  surface,
  resolveServer,
  className,
}: {
  surface: AuthChallengeSurface;
  resolveServer: (serverName: string) => ServerWithName | undefined;
  className?: string;
}) {
  const cards = useAuthChallengeCards(surface);
  const [message, setMessage] = useState<string | null>(null);
  if (cards.length === 0 && !message) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {cards.map((card) => (
        <AuthChallengeCard
          key={card.key}
          card={card}
          server={resolveServer(card.serverName)}
          onResult={(result) =>
            setMessage(authChallengeConnectMessage(result) ?? null)
          }
        />
      ))}
      {message ? (
        <p className="text-xs text-muted-foreground">{message}</p>
      ) : null}
    </div>
  );
}

/** What to tell the user about a Connect click that did not redirect. */
export function authChallengeConnectMessage(
  result: AuthChallengeConnectResult,
): string | undefined {
  switch (result.kind) {
    case "blocked":
      return result.hint;
    case "failed":
      return `Sign-in could not start: ${result.message}`;
    case "permanent":
      return "This server still asked for sign-in after you signed in, so the call was not retried.";
    case "refused":
      return "Click Connect to sign in.";
    default:
      return undefined;
  }
}
