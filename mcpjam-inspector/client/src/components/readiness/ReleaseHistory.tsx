import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { RecordRelease } from "./RecordRelease";
import { readinessPlatformClient } from "@/lib/apis/directory-readiness-api";
import type {
  SubmissionEvent,
  SubmissionSummary,
} from "@/lib/apis/directory-submissions-api";
import type {
  PlatformServerRevisionSummary,
  PlatformServerRevisionDiff,
} from "@mcpjam/sdk/platform";
import {
  readPublicationEvents,
  publishedReleases,
} from "./marketplace-publication";
import { STATUS_LABELS } from "./SubmissionStatus";

const date = (ms: number) => new Date(ms).toLocaleDateString();
const releaseName = (event: SubmissionEvent) =>
  event.snapshot?.note || "Published snapshot";

function CatalogDiff({
  projectId,
  serverId,
  from,
  to,
}: {
  projectId: string;
  serverId: string;
  from: number;
  to: number;
}) {
  const [diff, setDiff] = useState<PlatformServerRevisionDiff>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    if (from !== to)
      readinessPlatformClient()
        .diffServerRevisions(
          {
            projectId,
            serverId,
            fromRevisionNumber: from,
            revisionNumber: to,
          },
          { signal: abort.signal },
        )
        .then(
          (value) => {
            if (!abort.signal.aborted) setDiff(value);
          },
          () => {
            if (!abort.signal.aborted) setError(true);
          },
        );
    return () => abort.abort();
  }, [projectId, serverId, from, to]);
  if (from === to) return <p>Both use catalog revision {from}.</p>;
  if (!diff)
    return (
      <p>
        {error
          ? "Could not load the catalog comparison. Reopen the release history to try again."
          : "Loading catalog comparison…"}
      </p>
    );
  const { added, removed, changed } = diff.tools;
  return (
    <div className="space-y-2">
      <p>
        {added.length} tools added · {removed.length} removed · {changed.length}{" "}
        changed · {diff.discovery.length} server fields changed
      </p>
      {Boolean(
        diff.droppedFields.from.length || diff.droppedFields.to.length,
      ) && <p>Some fields were omitted from these captures.</p>}
      {[
        ...added.map((tool) => ({
          title: `Added · ${tool.name}`,
          values: tool,
        })),
        ...removed.map((tool) => ({
          title: `Removed · ${tool.name}`,
          values: tool,
        })),
        ...changed.map((tool) => ({
          title: `${tool.name} · ${tool.changedFields.join(", ")}`,
          values: { before: tool.before, after: tool.after },
        })),
        ...diff.discovery.map((field) => ({
          title: field.field,
          values: field,
        })),
      ].map((item) => (
        <details key={item.title}>
          <summary>{item.title}</summary>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(item.values, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

export function ReleaseHistory({
  projectId,
  submission,
  initiallyEditing = false,
}: {
  initiallyEditing?: boolean;
  projectId: string;
  submission: SubmissionSummary;
}) {
  const [data, setData] = useState<{
    events: SubmissionEvent[];
    revisions: PlatformServerRevisionSummary[];
  }>();
  const [error, setError] = useState("");
  const [revisionError, setRevisionError] = useState(false);
  const [editing, setEditing] = useState(initiallyEditing);
  const [baseline, setBaseline] = useState("");
  const [target, setTarget] = useState("candidate");
  const [refresh, setRefresh] = useState(0);
  const serverId = submission.serverId;
  const submissionId = submission.id;
  useEffect(() => {
    const abort = new AbortController();
    const scope = { projectId, submissionId };
    setError("");
    setRevisionError(false);
    const revisions = serverId
      ? readinessPlatformClient()
          .listServerRevisions(
            { projectId, serverId, limit: 100 },
            { signal: abort.signal },
          )
          .then(
            (page) => page.items,
            () => {
              if (!abort.signal.aborted) setRevisionError(true);
              return [];
            },
          )
      : Promise.resolve([]);
    Promise.all([readPublicationEvents(scope, abort.signal), revisions])
      .then(([events, revisions]) => {
        if (!abort.signal.aborted) setData({ events, revisions });
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("Could not load release history. Try again.");
      });
    return () => abort.abort();
  }, [projectId, serverId, submissionId, refresh]);
  const releases = publishedReleases(data?.events ?? []);
  const published = releases[0];
  const status = data?.events.find((e) => e.kind === "status");
  const candidate = data?.events.find((e) => e.snapshot?.label === "candidate")
    ?.snapshot?.revisionNumber;
  const candidateRevision = candidate ?? data?.revisions[0]?.revisionNumber;
  const before = releases.find((e) => e.id === baseline) ?? published;
  const after = releases.find((e) => e.id === target);
  const to = after ? after.snapshot?.revisionNumber : candidateRevision;
  const from = before?.snapshot?.revisionNumber;
  const liveLink =
    published?.link ??
    (status?.state === "published" ? status.link : undefined);
  return (
    <section className="space-y-4 rounded-lg border border-border p-5 text-sm">
      <h2 className="text-lg font-semibold">Published release</h2>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button variant="link" onClick={() => setRefresh((x) => x + 1)}>
            Retry
          </Button>
        </p>
      )}
      {revisionError && (
        <p role="alert">
          Could not load server revisions. Try again.{" "}
          <Button variant="link" onClick={() => setRefresh((x) => x + 1)}>
            Retry
          </Button>
        </p>
      )}
      {data ? (
        <>
          <p>
            {published
              ? `${releaseName(published)} · recorded ${date(published.createdAt)}`
              : status?.state === "published" && !status.uncertain
                ? "Recorded as published · version unknown"
                : "No published version recorded"}
          </p>
          {published?.evidence?.kind === "text" && (
            <p className="whitespace-pre-wrap">{published.evidence.value}</p>
          )}
          {published?.snapshot?.revisionNumber && (
            <p>MCP catalog revision {published.snapshot.revisionNumber}</p>
          )}
          {published?.detail && (
            <p className="whitespace-pre-wrap">{published.detail}</p>
          )}
          {liveLink?.startsWith("https://") && (
            <a
              className="underline"
              target="_blank"
              rel="noreferrer"
              href={liveLink}
            >
              Marketplace listing
            </a>
          )}
          {status?.state && (
            <p>
              Latest recorded status ·{" "}
              {STATUS_LABELS[status.state] ?? status.state}
              {status.uncertain && " (unconfirmed)"}
            </p>
          )}
          {releases.length > 1 && (
            <details>
              <summary>Previous releases ({releases.length - 1})</summary>
              <ul className="mt-2 space-y-3">
                {releases.slice(1).map((event) => (
                  <li key={event.id}>
                    <strong>{releaseName(event)}</strong> · recorded{" "}
                    {date(event.createdAt)}
                    {event.evidence?.kind === "text" && (
                      <p className="whitespace-pre-wrap">
                        {event.evidence.value}
                      </p>
                    )}
                    {event.detail && <p>{event.detail}</p>}
                    {event.link?.startsWith("https://") && (
                      <a
                        href={event.link}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        Marketplace listing
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {published && (
            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="font-medium">Compare releases</h3>
              <div className="flex flex-wrap gap-3">
                <label>
                  From{" "}
                  <select
                    value={before?.id}
                    onChange={(e) => setBaseline(e.target.value)}
                  >
                    {releases.map((e) => (
                      <option key={e.id} value={e.id}>
                        {releaseName(e)} · {date(e.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  To{" "}
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="candidate">
                      {candidate ? "Candidate" : "Latest server capture"}
                      {candidateRevision && ` · revision ${candidateRevision}`}
                    </option>
                    {releases.map((e) => (
                      <option key={e.id} value={e.id}>
                        {releaseName(e)} · {date(e.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {after &&
                before &&
                after.evidence?.value !== before.evidence?.value && (
                  <div>
                    <h4>Publication details</h4>
                    <p>Before · {before.evidence?.value || "Unknown"}</p>
                    <p>After · {after.evidence?.value || "Unknown"}</p>
                  </div>
                )}
              {after && before && after.link !== before.link && (
                <div>
                  <h4>Listing URL</h4>
                  <p>Before · {before.link || "Unknown"}</p>
                  <p>After · {after.link || "Unknown"}</p>
                </div>
              )}
              {after && before && before.detail !== after.detail && (
                <div>
                  <h4>Listing metadata</h4>
                  <p>Before · {before.detail || "Unknown"}</p>
                  <p>After · {after.detail || "Unknown"}</p>
                </div>
              )}
              {serverId && from && to ? (
                <CatalogDiff
                  key={`${from}:${to}`}
                  {...{ projectId, serverId, from, to }}
                />
              ) : (
                <p>A comparison needs a server revision for both releases.</p>
              )}
            </div>
          )}
          {serverId && !editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Record published version
            </Button>
          )}
          {editing && serverId && (
            <RecordRelease
              projectId={projectId}
              serverId={serverId}
              submission={submission}
              revisions={data.revisions}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                setBaseline("");
                setTarget("candidate");
                setRefresh((x) => x + 1);
              }}
            />
          )}
        </>
      ) : (
        !error && <p>Loading release history…</p>
      )}
    </section>
  );
}
