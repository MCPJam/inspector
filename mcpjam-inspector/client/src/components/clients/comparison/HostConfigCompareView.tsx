import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "react-router";
import { useHost, useHostList } from "@/hooks/useClients";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { HostCompareSelector } from "./HostCompareSelector";
import {
  parseHostsParam,
  resolveInitialHostCompareSelection,
  toggleHostCompareSelection,
  writeHostCompareSelection,
} from "./host-compare-selection";
import { HostConfigComparisonMatrix } from "./host-config-comparison-matrix";

const HOSTS_QUERY_PARAM = "hosts";

interface HostConfigCompareViewProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

/**
 * Top-level container for `/clients/compare`. Loads every host in the
 * project, lets the user pick which ones appear as columns, and renders
 * their hydrated `HostConfigDtoV2` side by side.
 */
export function HostConfigCompareView({
  projectId,
  isAuthenticated,
}: HostConfigCompareViewProps) {
  const { hosts, isLoading: listLoading } = useHostList({
    isAuthenticated,
    projectId,
  });

  const [subjectsByHost, setSubjectsByHost] = useState<
    Record<string, HostComparisonSubject>
  >({});
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>([]);
  const [divergingOnly, setDivergingOnly] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Tracks whether the initial URL-driven selection has been applied.
  // After the first resolve, subsequent URL changes are ignored — Compare
  // becomes the source of truth and mirrors back into the URL.
  const urlConsumedRef = useRef(false);

  const liveHostIds = useMemo(
    () => hosts.map((host) => host.hostId),
    [hosts],
  );

  useEffect(() => {
    if (listLoading) return;
    const urlSelection = urlConsumedRef.current
      ? null
      : parseHostsParam(searchParams.get(HOSTS_QUERY_PARAM));
    urlConsumedRef.current = true;
    setSelectedHostIds((previous) =>
      resolveInitialHostCompareSelection({
        projectId: projectId ?? "",
        liveHostIds,
        previousSelection: previous,
        urlSelection,
      }),
    );
  }, [listLoading, liveHostIds, projectId, searchParams]);

  useEffect(() => {
    if (!projectId || selectedHostIds.length === 0) return;
    writeHostCompareSelection(projectId, selectedHostIds);
  }, [projectId, selectedHostIds]);

  // Mirror selection → ?hosts=. Suppress when the selection is the default
  // "all live hosts" (in original order) so shared links stay clean.
  useEffect(() => {
    if (!urlConsumedRef.current) return;
    if (listLoading) return;
    // Skip while the selection hasn't been resolved yet. The selection
    // effect above sets `urlConsumedRef.current = true` synchronously and
    // queues the parsed-from-URL selection, so this effect runs in the same
    // commit with `selectedHostIds` still empty. Treating that as "default"
    // would delete `?hosts=` before the queued state lands, clobbering the
    // deep link. After resolve, `selectedHostIds` is always ≥ 1 (resolver
    // falls back to all live hosts; `toggleHostCompareSelection` keeps
    // `minSelected=1`), so an empty selection means "not yet resolved."
    if (selectedHostIds.length === 0) return;
    const isDefault =
      selectedHostIds.length === liveHostIds.length &&
      selectedHostIds.every((id, i) => id === liveHostIds[i]);
    const current = searchParams.get(HOSTS_QUERY_PARAM);
    if (isDefault) {
      if (current === null) return;
      const next = new URLSearchParams(searchParams);
      next.delete(HOSTS_QUERY_PARAM);
      setSearchParams(next, { replace: true });
      return;
    }
    const desired = selectedHostIds.join(",");
    if (current === desired) return;
    const next = new URLSearchParams(searchParams);
    next.set(HOSTS_QUERY_PARAM, desired);
    setSearchParams(next, { replace: true });
  }, [selectedHostIds, liveHostIds, listLoading, searchParams, setSearchParams]);

  const reportSubject = useCallback(
    (hostId: string, subject: HostComparisonSubject) => {
      setSubjectsByHost((prev) => {
        const existing = prev[hostId];
        if (
          existing &&
          existing.config === subject.config &&
          existing.hostName === subject.hostName
        ) {
          return prev;
        }
        return { ...prev, [hostId]: subject };
      });
    },
    [],
  );

  useEffect(() => {
    if (listLoading) return;
    const live = new Set(liveHostIds);
    setSubjectsByHost((prev) => {
      let mutated = false;
      const next: typeof prev = {};
      for (const [id, subject] of Object.entries(prev)) {
        if (live.has(id)) next[id] = subject;
        else mutated = true;
      }
      return mutated ? next : prev;
    });
  }, [liveHostIds, listLoading]);

  const selectedHostIdSet = useMemo(
    () => new Set(selectedHostIds),
    [selectedHostIds],
  );

  const orderedSubjects = useMemo(() => {
    return selectedHostIds
      .map((hostId) => subjectsByHost[hostId])
      .filter((subject): subject is HostComparisonSubject => subject !== undefined);
  }, [selectedHostIds, subjectsByHost]);

  const loadedSelectedCount = orderedSubjects.length;
  const totalSelectedCount = selectedHostIds.length;
  const allSelectedLoaded =
    !listLoading && loadedSelectedCount === totalSelectedCount;

  const handleToggleHost = useCallback((hostId: string) => {
    setSelectedHostIds((previous) =>
      toggleHostCompareSelection(previous, hostId),
    );
  }, []);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to compare your hosts.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {selectedHostIds.map((hostId) => {
        const host = hosts.find((entry) => entry.hostId === hostId);
        if (!host) return null;
        return (
          <HostConfigFetcher
            key={host.hostId}
            hostId={host.hostId}
            hostName={host.name}
            hostConfigId={host.hostConfigId}
            isAuthenticated={isAuthenticated}
            onLoaded={reportSubject}
          />
        );
      })}

      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-8">
        {listLoading ? (
          <LoadingState label="Loading hosts…" />
        ) : hosts.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No hosts yet. Create one from the Clients tab to populate the
              comparison.
            </p>
          </div>
        ) : (
          <>
            <HostCompareSelector
              hosts={hosts}
              selectedHostIds={selectedHostIds}
              subjectsByHost={subjectsByHost}
              onToggleHost={handleToggleHost}
              divergingOnly={divergingOnly}
              onDivergingOnlyChange={setDivergingOnly}
              disabled={listLoading}
            />

            {totalSelectedCount === 0 ? (
              <div className="rounded-xl border border-border bg-card p-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Select at least one client above to compare.
                </p>
              </div>
            ) : (
              <>
                {!allSelectedLoaded && (
                  <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading {loadedSelectedCount} / {totalSelectedCount} client
                    configs…
                  </div>
                )}
                <HostConfigComparisonMatrix
                  subjects={orderedSubjects}
                  divergingOnly={divergingOnly}
                  onRemoveHost={
                    selectedHostIdSet.size > 1 ? handleToggleHost : undefined
                  }
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function HostConfigFetcher({
  hostId,
  hostName,
  hostConfigId,
  isAuthenticated,
  onLoaded,
}: {
  hostId: string;
  hostName: string;
  hostConfigId: string;
  isAuthenticated: boolean;
  onLoaded: (hostId: string, subject: HostComparisonSubject) => void;
}) {
  const { host } = useHost({ isAuthenticated, hostId });

  useEffect(() => {
    // Only publish on success. `useHost` returns null for both "loading" and
    // "not found"; calling onLoaded(null) during loading would wipe the cached
    // subject when a host is deselected then re-selected. Dead-host removal is
    // handled by the liveHostIds cleanup effect above.
    if (!host) return;
    onLoaded(hostId, {
      hostId,
      hostName: host.name ?? hostName,
      hostStyle: host.config.hostStyle,
      configHashShort: hostConfigId.slice(-6),
      config: host.config,
    });
  }, [host, hostId, hostName, hostConfigId, onLoaded]);

  return null;
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      {label}
    </div>
  );
}
