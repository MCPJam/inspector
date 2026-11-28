import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { isConvexQueryNotServed } from "@/lib/convex-error";

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
 * not serve this read as missing audit history. Other failures show the
 * History tab's unavailable message.
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
  // Project members can see server URL changes on every plan, independently
  // of the auditLog entitlement.
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
  viewerEmail,
  children,
}: {
  event: ServerUrlChangeEvent;
  viewerEmail?: string;
  children: ReactNode;
}) {
  const { previousOrigin, nextOrigin, viaTransportFlip, clearedOnOriginChange } =
    event.metadata ?? {};
  const commandChanged = event.action === CREDENTIALS_CLEARED_ACTION;
  const cleared = commandChanged || clearedOnOriginChange === true;
  const clearedKinds = clearedCredentialLabels(event);
  const sameOrigin = previousOrigin != null && previousOrigin === nextOrigin;
  const { actorEmail } = event;
  const changedByViewer =
    actorEmail !== null &&
    actorEmail.toLowerCase() === viewerEmail?.toLowerCase();
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
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
          {previousOrigin && !sameOrigin && (
            <>
              <dt className="text-muted-foreground">From</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">
                {previousOrigin}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">
            {sameOrigin ? "Origin" : "To"}
          </dt>
          <dd className="font-mono [overflow-wrap:anywhere]">
            {nextOrigin}
          </dd>
        </dl>
      )}
      {viaTransportFlip && (
        <p className="text-xs text-muted-foreground">
          The saved URL is no longer used.
        </p>
      )}
      <p
        className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
        title={changedByViewer ? actorEmail : undefined}
      >
        Changed by {changedByViewer ? "you" : (actorEmail ?? "an unknown user")}
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
