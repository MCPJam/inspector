/**
 * Where this server has been pointed, and whether that cleared credentials.
 *
 * MJ-003 acceptance criterion 3. The backend records the change and reads it
 * back through `auditEvents:listServerUrlChanges`, which is deliberately NOT
 * gated on the `auditLog` entitlement — the organization audit log is, and the
 * member whose saved credential was destroyed by somebody else's edit is
 * usually on a plan that cannot open it. This is the surface that makes the
 * record reachable for them.
 *
 * Renders nothing when there is no history. A server nobody has repointed
 * should not carry an empty panel explaining that it has not been repointed.
 */

import { useQuery } from "convex/react";
import { describeError } from "@mcpjam/sdk/browser";
import { ErrorBoundary } from "@/components/ui/error-boundary";
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

interface ServerUrlChangeEvent {
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

interface ServerUrlChangeHistoryProps {
  /** The canonical server document id, or null when it is not resolved yet. */
  serverId: string | null;
  recovery?: {
    server: ServerWithName;
    auth: ServerAuth;
  };
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

function formatWhen(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return new Date(timestamp).toISOString();
  }
}

/**
 * The failure this panel EXPECTS: the deployment does not serve its query.
 *
 * The Inspector half of MJ-003 shipped ahead of the backend half, and
 * `useQuery` throws during render while the function is missing. That throw
 * escaped to the route boundary and took the whole Servers page down the
 * moment anyone opened a hosted server's details (PostHog issue
 * 01a08999-8c34-77a2-922e-557c0e515919). The boundary below is what keeps a
 * read-only, renders-nothing-by-default panel from ever doing that again —
 * still worth having now that the query is deployed, for a browser left open
 * across a rollback.
 *
 * `isConvexQueryNotServed` matches both the dev shape and the production
 * redaction of THIS query. A `ConvexError` from it (`NOT_FOUND` for a
 * non-member) carries its own message and still reports.
 */
export function isServerUrlHistoryUnavailable(error: Error): boolean {
  return isConvexQueryNotServed(error, SERVER_URL_CHANGES_QUERY);
}

export function ServerUrlChangeHistory(props: ServerUrlChangeHistoryProps) {
  const { serverId } = props;
  return (
    // KEYED by the server: a boundary that has caught stays in its fallback
    // for the life of the element, so without the key one failure would hide
    // the history for every server opened after it in the same modal.
    //
    // `fallback={null}` is this panel's own contract — nothing to say, draw
    // nothing. `isExpectedError` suppresses only the telemetry, and only for
    // the shape the predicate can name; a genuine render bug still reports.
    <ErrorBoundary
      key={serverId ?? "no-server"}
      name="server-url-change-history"
      fallback={null}
      isExpectedError={isServerUrlHistoryUnavailable}
    >
      <ServerUrlChangeHistoryPanel {...props} />
    </ErrorBoundary>
  );
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

function DestinationChange({ event }: { event: ServerUrlChangeEvent }) {
  const previous = event.metadata?.previousOrigin ?? null;
  const next = event.metadata?.nextOrigin ?? null;

  if (event.action === CREDENTIALS_CLEARED_ACTION) {
    // A stdio row. The backend records origins as null for it — a command is
    // not an origin — and never records the command itself, because it is
    // the caller's own string.
    return (
      <span className="text-muted-foreground">
        Pointed at a different command
      </span>
    );
  }

  if (event.metadata?.viaTransportFlip === true) {
    return (
      <span className="text-muted-foreground">
        Switched to a local command. The saved URL is no longer used.
      </span>
    );
  }

  if (previous && next && previous !== next) {
    return (
      <>
        <span className="font-mono">{previous}</span>
        <span className="text-muted-foreground">→</span>
        <span className="font-mono">{next}</span>
      </>
    );
  }

  return (
    <span className="text-muted-foreground">
      URL changed{next ? " within " : ""}
      {next ? <span className="font-mono">{next}</span> : null}
    </span>
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
  if (
    error?.slug !== "auth/http_401" &&
    error?.slug !== "auth/http_403" &&
    error?.slug !== "auth/consent_required" &&
    error?.slug !== "oauth/no_bearer_challenge"
  ) return null;
  return <ServerUrlChangeHistory serverId={serverId} recovery={{ server, auth }} />;
}

function recoveryMessage(
  changes: ServerUrlChangeEvent[],
  { server, auth }: NonNullable<ServerUrlChangeHistoryProps["recovery"]>
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
  return missing.length > 0
    ? `Re-enter the ${credentialList.format(missing)} to reconnect.`
    : null;
}

function ServerUrlChangeHistoryPanel({
  serverId,
  recovery,
}: ServerUrlChangeHistoryProps) {
  const events = useQuery(
    SERVER_URL_CHANGES_QUERY as never,
    serverId ? ({ serverId } as never) : "skip",
  ) as ServerUrlChangeEvent[] | undefined;

  // `Array.isArray`, not a truthiness-and-length check. `undefined` is still
  // loading and an empty array is a server nobody has repointed — both render
  // nothing, because this panel is only interesting when it has something to
  // say. But the value crosses a boundary this component does not control, and
  // anything else arriving (a stubbed query in a test, a shape change upstream)
  // reached `.filter` below and took the whole modal down with a TypeError.
  // A read from outside gets checked, not assumed.
  if (!Array.isArray(events) || events.length === 0) return null;

  const changes = events.filter(isRenderableEvent);
  if (changes.length === 0) return null;

  if (recovery) {
    const message = recoveryMessage(changes, recovery);
    return message ? (
      <p role="status" className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
        {message}
      </p>
    ) : null;
  }

  return (
    <div className="space-y-2 pt-2">
      <h3 className="text-sm font-medium">Server URL and command changes</h3>
      <ul className="space-y-1.5">
        {changes.map((event) => {
          // The clear event exists only because something was cleared; the url
          // event fires for same-origin edits too and says so itself.
          const cleared =
            event.action === CREDENTIALS_CLEARED_ACTION ||
            event.metadata?.clearedOnOriginChange === true;
          const clearedKindLabels = clearedCredentialLabels(event);
          return (
            <li
              key={event.id}
              className="rounded-md border border-border px-2.5 py-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <DestinationChange event={event} />
              </div>
              <div className="mt-0.5 text-muted-foreground">
                {event.actorEmail ?? "Unknown user"} ·{" "}
                {formatWhen(event.timestamp)}
              </div>
              {cleared && (
                <div className="mt-1 text-warning">
                  Cleared {clearedKindLabels.length > 0
                    ? credentialList.format(clearedKindLabels)
                    : "saved credentials"}.
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
