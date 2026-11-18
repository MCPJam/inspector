import { useEffect, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  listServerSubmissions,
  createDirectorySubmission,
  type SubmissionSummary,
} from "@/lib/apis/directory-submissions-api";
import { ReleaseHistory } from "./ReleaseHistory";
import type { Marketplace } from "./MarketplaceCards";

export function MarketplaceOverview({
  projectId,
  serverId,
  directory,
  pluginsEnabled,
  initialSubmissionId,
  onOpen,
}: {
  projectId: string;
  serverId?: string;
  directory: Marketplace;
  pluginsEnabled: boolean;
  initialSubmissionId?: string;
  onOpen: (id: string, automatic: boolean, serverId: string) => void;
}) {
  const [rows, setRows] = useState<SubmissionSummary[]>();
  const [selection, select] = useState(initialSubmissionId);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const newRelease = useRef<string | null>(null);
  const creationKey = useRef(crypto.randomUUID());
  useEffect(() => {
    active.current = true;
    const abort = new AbortController();
    setError("");
    listServerSubmissions(projectId, serverId, abort.signal).then(
      (items) => {
        if (!abort.signal.aborted)
          setRows(
            items
              .filter((item) => item.directory === directory)
              .sort((a, b) => b.updatedAt - a.updatedAt),
          );
      },
      () => {
        if (!abort.signal.aborted) setError("Could not load submissions. Try again.");
      },
    );
    return () => {
      active.current = false;
      abort.abort();
    };
  }, [projectId, serverId, directory, retry]);
  const selected = selection === "" ? undefined : rows?.find((item) => item.id === selection) ?? rows?.[0];
  const allowed = directory === "claude" || pluginsEnabled;
  async function open(mode: "automatic" | "manual" | "release") {
    const targetServer = selected?.serverId ?? serverId;
    if (busy || !rows || (!allowed && mode !== "release") || !targetServer)
      return;
    setBusy(true);
    try {
      const record =
        selected ??
        (await createDirectorySubmission(
          {
            projectId,
            serverId: targetServer,
            flowId:
              directory === "claude" ? "claude-connector" : "chatgpt-plugin",
          },
          `ui-${serverId}-${creationKey.current}`,
        ));
      if (!active.current) return;
      if (mode === "release") {
        setRows((items) => [record, ...(items ?? [])]);
        newRelease.current = record.id;
        select(record.id);
        setBusy(false);
        creationKey.current = crypto.randomUUID();
      } else {
        onOpen(record.id, mode === "automatic", targetServer);
      }
    } catch (failure) {
      if (active.current) {
        setBusy(false);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not open the submission. Try opening it again.",
        );
      }
    }
  }
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <h1 className="text-2xl font-semibold">
          {directory === "claude" ? "Claude" : "ChatGPT"} releases
        </h1>
        {error && (
          <p role="alert">
            {error}{" "}
            <Button variant="link" onClick={() => setRetry((x) => x + 1)}>
              Retry
            </Button>
          </p>
        )}
        {!!rows?.length && (
          <label className="flex flex-wrap items-center gap-3 text-sm">
            Submission{" "}
            <select
              value={selected?.id ?? ""}
              onChange={(e) => select(e.target.value)}
            >
              {rows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title ||
                    `Submission · ${new Date(item.createdAt).toLocaleString()}`}
                </option>
              ))}
              <option value="">New submission</option>
            </select>
          </label>
        )}
        {selected ? (
          <ReleaseHistory
            key={selected.id}
            projectId={projectId}
            submission={selected}
            initiallyEditing={selected.id === newRelease.current}
          />
        ) : (
          <p>
            {rows
              ? "No published version recorded for this submission."
              : !error && "Loading submissions…"}
          </p>
        )}
        {rows && !selected && serverId && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void open("release")}
          >
            Record published version
          </Button>
        )}
        {!selected?.serverId && !serverId && (
          <p>Choose a saved server to start a submission.</p>
        )}
        {allowed ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Run checks</h2>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!rows || busy || !(selected?.serverId || serverId)}
                onClick={() => void open("automatic")}
              >
                Start checks
              </Button>
              <Button
                disabled={!rows || busy || !(selected?.serverId || serverId)}
                variant="outline"
                onClick={() => void open("manual")}
              >
                Go step by step
              </Button>
            </div>
          </section>
        ) : (
          <p>Plugin checks require Agent Plugins.</p>
        )}
      </div>
    </main>
  );
}
