/**
 * Where this server has been repointed, and whether that cleared credentials.
 *
 * MJ-003 acceptance criterion 3. The backend records a url change and reads it
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

interface ServerUrlChangeEvent {
  id: string;
  action: string;
  actorEmail: string | null;
  timestamp: number;
  metadata?: {
    previousOrigin?: string | null;
    nextOrigin?: string | null;
    originChanged?: boolean;
    clearedOnOriginChange?: boolean;
    clearedKinds?: string[];
  } | null;
}

/**
 * Backend category names, in words. Unknown keys fall through unchanged rather
 * than being dropped: a kind added on the backend should still be visible here
 * before anyone remembers to update this map.
 */
const CLEARED_KIND_LABELS: Record<string, string> = {
  env: "environment variables",
  headers: "request headers",
  legacy_env: "environment variables",
  legacy_headers: "request headers",
  client_secret: "OAuth client secret",
  xaa_dcr: "cross-app client registration",
  oauth_tokens: "OAuth tokens",
};

interface ServerUrlChangeHistoryProps {
  /** The canonical server document id, or null when it is not resolved yet. */
  serverId: string | null;
}

function formatWhen(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return new Date(timestamp).toISOString();
  }
}

export function ServerUrlChangeHistory({
  serverId,
}: ServerUrlChangeHistoryProps) {
  const events = useQuery(
    "auditEvents:listServerUrlChanges" as never,
    serverId ? ({ serverId } as never) : "skip"
  ) as ServerUrlChangeEvent[] | undefined;

  // `Array.isArray`, not a truthiness-and-length check. `undefined` is still
  // loading and an empty array is a server nobody has repointed — both render
  // nothing, because this panel is only interesting when it has something to
  // say. But the value crosses a boundary this component does not control, and
  // anything else arriving (a stubbed query in a test, a shape change upstream)
  // reached `.filter` below and took the whole modal down with a TypeError.
  // A read from outside gets checked, not assumed.
  if (!Array.isArray(events) || events.length === 0) return null;

  // One row per edit. The backend also records the credential clear as its own
  // action, because the destruction is a fact in its own right — but rendering
  // both would read as two edits, and the url-change event already carries
  // `clearedOnOriginChange` AND `clearedKinds`, so nothing is lost by showing
  // only this one. That is deliberate on the backend side: putting the kinds on
  // the event that describes the change means nothing here has to correlate two
  // audit rows by timestamp to say what went.
  const urlChanges = events.filter((e) => e.action === "server.url.changed");
  if (urlChanges.length === 0) return null;

  return (
    <div className="space-y-2 pt-2">
      <p className="text-xs font-medium">URL history</p>
      <ul className="space-y-1.5">
        {urlChanges.map((event) => {
          const previous = event.metadata?.previousOrigin ?? null;
          const next = event.metadata?.nextOrigin ?? null;
          const cleared = event.metadata?.clearedOnOriginChange === true;
          const clearedKindLabels = Array.isArray(event.metadata?.clearedKinds)
            ? event.metadata.clearedKinds
                .map((kind) => CLEARED_KIND_LABELS[kind] ?? kind)
                .filter((label, index, all) => all.indexOf(label) === index)
            : [];
          return (
            <li
              key={event.id}
              className="rounded-md border border-border px-2.5 py-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                {previous && next && previous !== next ? (
                  <>
                    <span className="font-mono">{previous}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-mono">{next}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    URL changed{next ? " within " : ""}
                    {next ? <span className="font-mono">{next}</span> : null}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-muted-foreground">
                {event.actorEmail ?? "Unknown user"} ·{" "}
                {formatWhen(event.timestamp)}
              </div>
              {cleared && (
                <div className="mt-1 text-amber-600 dark:text-amber-500">
                  Saved credentials were cleared and need re-entering
                  {clearedKindLabels.length > 0
                    ? `: ${clearedKindLabels.join(", ")}`
                    : ""}
                  .
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
