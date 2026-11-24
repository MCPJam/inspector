import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { describeError } from "@mcpjam/sdk/browser";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { isConvexQueryNotServed } from "@/lib/convex-error";
import { credentialOriginOf } from "@/lib/credential-origin";
import type { ServerWithName } from "@/state/app-types";
import type { ServerAuth } from "./server-auth";

/**
 * Exported so the test can build the exact message the client sees, and so a
 * rename here cannot drift from the predicate below.
 */
export const SERVER_URL_CHANGES_QUERY = "auditEvents:listServerUrlChanges";

const URL_CHANGED_ACTION = "server.url.changed";
const CREDENTIALS_CLEARED_ACTION =
  "server.credentials.cleared_on_origin_change";

export interface ServerUrlChangeEvent {
  // `id`, not Convex's `_id`: the query projects the row rather than returning
  // it, so that the metadata it exposes is a decided list rather than whatever
  // the audit table happens to hold.
  id: string;
  action: string;
  actorEmail: string | null;
  timestamp: number;
  metadata?: {
    // Which vector moved the destination. Both events carry it.
    cause?: string | null;
    previousOrigin?: string | null;
    nextOrigin?: string | null;
    clearedOnOriginChange?: boolean;
    // An http row switched to stdio keeps its `url` and stops reading it. The
    // url event still fires, so without this the panel would tell somebody
    // their URL changed when the row still holds the one they can see.
    viaTransportFlip?: boolean;
    clearedKinds?: string[];
  } | null;
}

/** Credential names as they appear in Config. */
const CLEARED_KIND_LABELS: Record<string, string> = {
  env: "environment variables",
  headers: "request headers",
  bearer_token: "bearer token",
  legacy_env: "environment variables",
  legacy_headers: "request headers",
  client_secret: "OAuth client secret",
  xaa_dcr: "cross-app client registration",
  oauth_tokens: "OAuth tokens",
};

const credentialList = new Intl.ListFormat("en");

interface RecoveryContext {
  server: ServerWithName;
  auth: ServerAuth;
  isForbidden: boolean;
}

function clearedCredentialLabels(event: ServerUrlChangeEvent): string[] {
  const kinds = event.metadata?.clearedKinds;
  if (!Array.isArray(kinds)) return [];
  return [...new Set(kinds.map((kind) =>
    Object.hasOwn(CLEARED_KIND_LABELS, kind)
      ? CLEARED_KIND_LABELS[kind]
      : "other credentials"
  ))];
}

/**
 * Inspector can outlive a backend rollback. Treat a deployment that does
 * not serve this read as missing audit history instead of failing History
 * or Config. A ConvexError refusal carries its own message.
 */
export function isServerUrlHistoryUnavailable(error: Error): boolean {
  return isConvexQueryNotServed(error, SERVER_URL_CHANGES_QUERY);
}

/**
 * One line saying what moved, for one event.
 *
 * A url repoint writes both actions and a stdio command swap writes only the
 * clear, so the clear row is a row of its own exactly when it is the only
 * record of the edit. Otherwise it is dropped: two rows for one edit reads as
 * two edits, and the url event already carries `clearedKinds`.
 */
function isRenderableEvent(event: ServerUrlChangeEvent): boolean {
  return (
    event.action === URL_CHANGED_ACTION ||
    (event.action === CREDENTIALS_CLEARED_ACTION &&
      event.metadata?.cause === "stdio_target_change")
  );
}

function renderableChanges(events: ServerUrlChangeEvent[] | undefined) {
  return Array.isArray(events) ? events.filter(isRenderableEvent) : [];
}

export function useServerUrlChangeEvents(serverId: string) {
  // Revisions remain available when the audit query fails. The Convex
  // subscription reports the failure independently of this view.
  const { data, error } = useSoftQuery<ServerUrlChangeEvent[]>(
    SERVER_URL_CHANGES_QUERY,
    { serverId }
  );
  return {
    changes: renderableChanges(data),
    isLoading: data === undefined && !error,
    hasError: !!error && !isServerUrlHistoryUnavailable(error),
  };
}

export function ServerUrlChangeDetails({
  event,
  children,
}: {
  event: ServerUrlChangeEvent;
  children: ReactNode;
}) {
  const { previousOrigin, nextOrigin, viaTransportFlip, clearedOnOriginChange } =
    event.metadata ?? {};
  const commandChanged = event.action === CREDENTIALS_CLEARED_ACTION;
  const cleared = commandChanged || clearedOnOriginChange === true;
  const clearedKinds = clearedCredentialLabels(event);
  const sameOrigin = previousOrigin != null && previousOrigin === nextOrigin;
  let title = "Server URL changed";
  if (commandChanged) title = "Server command changed";
  else if (viaTransportFlip) title = "Switched to a local command";
  return (
    <div className="space-y-1 px-2 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
      {nextOrigin && !viaTransportFlip && !commandChanged && (
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs">
          {sameOrigin && <span className="text-muted-foreground">Within</span>}
          {previousOrigin && !sameOrigin && (
            <>
              <span className="font-mono [overflow-wrap:anywhere]">
                {previousOrigin}
              </span>
              <span className="sr-only">to</span>
              <ArrowRight
                aria-hidden="true"
                className="size-3 text-muted-foreground"
              />
            </>
          )}
          <span className="font-mono [overflow-wrap:anywhere]">
            {nextOrigin}
          </span>
        </div>
      )}
      {viaTransportFlip && (
        <p className="text-xs text-muted-foreground">
          The saved URL is no longer used.
        </p>
      )}
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {event.actorEmail ?? "Unknown user"}
      </p>
      {cleared && (
        <p className="flex items-start gap-1.5 text-xs">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3 shrink-0 text-warning"
          />
          <span>
            Cleared{" "}
            {clearedKinds.length
              ? credentialList.format(clearedKinds)
              : "saved credentials"}
            .
          </span>
        </p>
      )}
    </div>
  );
}

export function ServerCredentialRecovery({
  serverId,
  server,
  auth,
}: {
  serverId: string | null;
  server: ServerWithName;
  auth: ServerAuth;
}) {
  if (!serverId || server.connectionStatus !== "failed") return null;
  const error = server.lastNormalizedError ??
    (server.lastError ? describeError(server.lastError) : null);
  const isForbidden = error?.slug === "auth/http_403";
  if (
    error?.slug !== "auth/http_401" &&
    error?.slug !== "auth/consent_required" &&
    error?.slug !== "oauth/no_bearer_challenge" &&
    !isForbidden
  ) return null;
  return (
    <ErrorBoundary
      key={serverId}
      name="server-url-change-history"
      fallback={null}
      isExpectedError={isServerUrlHistoryUnavailable}
    >
      <CredentialRecoveryMessage
        serverId={serverId}
        server={server}
        auth={auth}
        isForbidden={isForbidden}
      />
    </ErrorBoundary>
  );
}

function recoveryMessage(
  changes: ServerUrlChangeEvent[],
  {
    server,
    auth,
    isForbidden,
  }: RecoveryContext
): string | null {
  const origin = credentialOriginOf(server.config.url?.toString());
  if (!origin) return null;
  // Match the latest address change. A path edit keeps credentials bound to
  // the same origin, so it doesn't supersede a credential clear.
  const latestChange = changes.find(({ action, metadata }) =>
    action === CREDENTIALS_CLEARED_ACTION ||
    metadata?.viaTransportFlip ||
    metadata?.previousOrigin !== metadata?.nextOrigin
  );
  if (
    latestChange?.metadata?.nextOrigin !== origin ||
    !latestChange.metadata.clearedOnOriginChange
  ) return null;

  const usesClientSecret =
    auth.method === "oauth" ||
    auth.method === "xaa" ||
    (auth.method === "auto" && server.registrationMode === "preregistered");
  const missing = clearedCredentialLabels(latestChange).filter((label) =>
    (label === "request headers" && !auth.headers) ||
    (label === "bearer token" && !auth.bearer && auth.method === "bearer") ||
    (label === "OAuth client secret" && !server.hasClientSecret && usesClientSecret)
  );
  if (missing.length === 0) return null;
  const credentials = credentialList.format(missing);
  // A 403 can also come from an access policy such as an IP allowlist.
  return isForbidden
    ? `The URL change cleared the ${credentials}. Check which credentials the server requires.`
    : `Re-enter the ${credentials} to reconnect.`;
}

function CredentialRecoveryMessage({
  serverId,
  ...recovery
}: RecoveryContext & { serverId: string }) {
  const events = useQuery(
    SERVER_URL_CHANGES_QUERY as never,
    { serverId } as never,
  ) as ServerUrlChangeEvent[] | undefined;

  const message = recoveryMessage(renderableChanges(events), recovery);
  return message ? (
    <p role="status" className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      {message}
    </p>
  ) : null;
}
