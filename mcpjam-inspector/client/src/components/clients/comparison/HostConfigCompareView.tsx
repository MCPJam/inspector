import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Switch } from "@mcpjam/design-system/switch";
import { useHost, useHostList } from "@/hooks/useClients";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { HostConfigComparisonMatrix } from "./host-config-comparison-matrix";

interface HostConfigCompareViewProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

/**
 * Top-level container for `/clients/compare`. Fetches every host's
 * hydrated `HostConfigDtoV2` and feeds them to the comparison matrix.
 *
 * Per-host fetching is parallelized via one `useHost` subscription per
 * row (`HostConfigFetcher`). Convex queries dedupe and the host count
 * is bounded by what the user has saved (typically <20), so a fan-out
 * subscription is cheaper than adding a dedicated list-with-config
 * backend query just for this view.
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
  const [divergingOnly, setDivergingOnly] = useState(false);

  const reportSubject = useCallback(
    (hostId: string, subject: HostComparisonSubject | null) => {
      setSubjectsByHost((prev) => {
        if (subject === null) {
          if (!(hostId in prev)) return prev;
          const next = { ...prev };
          delete next[hostId];
          return next;
        }
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

  // Drop subjects whose host disappeared from the list (host deleted
  // elsewhere). Without this, the matrix would keep rendering a stale
  // column until the page reloads.
  useEffect(() => {
    if (listLoading) return;
    const live = new Set(hosts.map((h) => h.hostId));
    setSubjectsByHost((prev) => {
      let mutated = false;
      const next: typeof prev = {};
      for (const [id, s] of Object.entries(prev)) {
        if (live.has(id)) next[id] = s;
        else mutated = true;
      }
      return mutated ? next : prev;
    });
  }, [hosts, listLoading]);

  const orderedSubjects = useMemo(() => {
    return hosts
      .map((h) => subjectsByHost[h.hostId])
      .filter((s): s is HostComparisonSubject => s !== undefined);
  }, [hosts, subjectsByHost]);

  const loadedCount = orderedSubjects.length;
  const totalCount = hosts.length;
  const allLoaded = !listLoading && loadedCount === totalCount;

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to compare your hosts.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {hosts.map((h) => (
        <HostConfigFetcher
          key={h.hostId}
          hostId={h.hostId}
          hostName={h.name}
          hostConfigId={h.hostConfigId}
          isAuthenticated={isAuthenticated}
          onLoaded={reportSubject}
        />
      ))}

      <header className="shrink-0 border-b border-border/40 px-4 py-3 md:px-8">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h1 className="text-[15px] font-medium leading-tight">
              Host config comparison
            </h1>
            <p className="text-[12px] text-muted-foreground leading-tight">
              Every saved <code className="font-mono">hostConfig</code> in this
              project, side by side.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <label className="flex items-center gap-2 cursor-pointer">
              <Switch
                checked={divergingOnly}
                onCheckedChange={setDivergingOnly}
                aria-label="Show only diverging fields"
              />
              <span>Only diverging</span>
            </label>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-8">
        {listLoading ? (
          <LoadingState label="Loading hosts…" />
        ) : totalCount === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No hosts yet. Create one from the Clients tab to populate the
              comparison.
            </p>
          </div>
        ) : (
          <>
            {!allLoaded && (
              <div className="mb-3 text-[11px] text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading {loadedCount} / {totalCount} host configs…
              </div>
            )}
            <HostConfigComparisonMatrix
              subjects={orderedSubjects}
              divergingOnly={divergingOnly}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Hidden subscriber. Calls `useHost` for one host and reports the
 * hydrated DTO back via callback so the parent can collect everyone's
 * config into a single subjects array.
 */
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
  onLoaded: (hostId: string, subject: HostComparisonSubject | null) => void;
}) {
  const { host } = useHost({ isAuthenticated, hostId });

  useEffect(() => {
    if (!host) {
      onLoaded(hostId, null);
      return;
    }
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
