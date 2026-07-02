import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "react-router";
import { useHost, useHostList } from "@/hooks/useClients";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { HostCompareSelector } from "./HostCompareSelector";
import {
  DEFAULT_COMPARE_HOST_IDS,
  parseHostsParam,
  resolveInitialHostCompareSelection,
  toggleHostCompareSelection,
  writeHostCompareSelection,
} from "./host-compare-selection";
import { buildPresetCompareEntries } from "./host-compare-presets";
import { HostConfigComparisonMatrix } from "./host-config-comparison-matrix";
import { HostCapabilityListView } from "./HostCapabilityListView";
import {
  computeVisibleFieldIds,
  isSupportField,
  type SupportFilterMode,
} from "./support-level";
import {
  HOST_CONFIG_FIELDS,
  hostConfigField,
} from "@/lib/host-config-field-schema";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";

type CompareViewMode = "table" | "list";

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
  const { hosts: liveHosts, isLoading: listLoading } = useHostList({
    isAuthenticated,
    projectId,
  });

  // Static host profiles (Claude, ChatGPT, Cursor, …) offered as opt-in
  // comparison columns even when the user hasn't created them — the same
  // best-effort profiles the server detail modal's Hosts tab renders. Threaded
  // with the current theme so preset configs match the rest of the app.
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const presets = useMemo(
    () => buildPresetCompareEntries(themeMode),
    [themeMode],
  );

  // Real created hosts first, then presets — what the selector chips iterate.
  const hosts = useMemo(
    () => [...liveHosts, ...presets.hosts],
    [liveHosts, presets.hosts],
  );

  const [subjectsByHost, setSubjectsByHost] = useState<
    Record<string, HostComparisonSubject>
  >({});
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>([]);
  const [divergingOnly, setDivergingOnly] = useState(false);
  const [supportFilter, setSupportFilter] = useState<SupportFilterMode>("all");
  const [fieldSearchQuery, setFieldSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<CompareViewMode>("table");
  const [showDescriptions, setShowDescriptions] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Tracks whether the initial URL-driven selection has been applied.
  // After the first resolve, subsequent URL changes are ignored — Compare
  // becomes the source of truth and mirrors back into the URL.
  const urlConsumedRef = useRef(false);

  // Real created hosts only — the last-resort fallback inside
  // `resolveInitialHostCompareSelection` if the Codex/Claude Code presets
  // are ever unavailable. The actual default selection is
  // `DEFAULT_COMPARE_HOST_IDS` (see the ?hosts=-is-default suppression below).
  const liveHostIds = useMemo(
    () => liveHosts.map((host) => host.hostId),
    [liveHosts],
  );
  // Every selectable id (real + preset). URL / stored selections reconcile
  // against this so a chosen preset column survives a reload.
  const knownHostIds = useMemo(
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
        knownHostIds,
        previousSelection: previous,
        urlSelection,
      }),
    );
  }, [listLoading, liveHostIds, knownHostIds, projectId, searchParams]);

  useEffect(() => {
    if (!projectId || selectedHostIds.length === 0) return;
    writeHostCompareSelection(projectId, selectedHostIds);
  }, [projectId, selectedHostIds]);

  // Mirror selection → ?hosts=. Suppress when the selection is the default
  // (Codex + Claude Code, in that order) so shared links stay clean.
  useEffect(() => {
    if (!urlConsumedRef.current) return;
    if (listLoading) return;
    // Skip while the selection hasn't been resolved yet. The selection
    // effect above sets `urlConsumedRef.current = true` synchronously and
    // queues the parsed-from-URL selection, so this effect runs in the same
    // commit with `selectedHostIds` still empty. Treating that as "default"
    // would delete `?hosts=` before the queued state lands, clobbering the
    // deep link. After resolve, `selectedHostIds` is always ≥ 1 (resolver
    // falls back to the Codex/Claude Code presets, or live hosts if those
    // are unavailable; `toggleHostCompareSelection` keeps `minSelected=1`),
    // so an empty selection means "not yet resolved."
    if (selectedHostIds.length === 0) return;
    const isDefault =
      selectedHostIds.length === DEFAULT_COMPARE_HOST_IDS.length &&
      selectedHostIds.every((id, i) => id === DEFAULT_COMPARE_HOST_IDS[i]);
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
  }, [selectedHostIds, listLoading, searchParams, setSearchParams]);

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

  // Preset subjects are static and available immediately; fetched real-host
  // subjects (keyed by Convex id, no prefix collision) layer on top.
  const allSubjects = useMemo(
    () => ({ ...presets.subjects, ...subjectsByHost }),
    [presets.subjects, subjectsByHost],
  );

  const orderedSubjects = useMemo(() => {
    return selectedHostIds
      .map((hostId) => allSubjects[hostId])
      .filter((subject): subject is HostComparisonSubject => subject !== undefined);
  }, [selectedHostIds, allSubjects]);

  const loadedSelectedCount = orderedSubjects.length;
  const totalSelectedCount = selectedHostIds.length;
  const allSelectedLoaded =
    !listLoading && loadedSelectedCount === totalSelectedCount;

  const handleToggleHost = useCallback((hostId: string) => {
    setSelectedHostIds((previous) =>
      toggleHostCompareSelection(previous, hostId),
    );
  }, []);

  // "N / M fields" count for the search header — same predicate the matrix and
  // list view use, so the number always matches what's rendered. In list mode
  // only support-shaped rows render, so the count narrows to that subset too.
  const matchCount = useMemo(() => {
    const ids = computeVisibleFieldIds({
      configs: orderedSubjects.map((s) => s.config),
      divergingOnly,
      supportFilter,
      searchQuery: fieldSearchQuery,
    });
    if (viewMode !== "list") return ids.size;
    let n = 0;
    for (const id of ids) {
      if (isSupportField(hostConfigField(id))) n += 1;
    }
    return n;
  }, [orderedSubjects, divergingOnly, supportFilter, fieldSearchQuery, viewMode]);

  const totalFieldCount = useMemo(
    () =>
      viewMode === "list"
        ? HOST_CONFIG_FIELDS.filter(isSupportField).length
        : HOST_CONFIG_FIELDS.length,
    [viewMode],
  );

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
        // Only real hosts hydrate over the wire — preset subjects are already
        // in `presets.subjects`, so a preset id finds no `liveHosts` row and
        // mounts no fetcher (and fires no Convex query against a synthetic id).
        const host = liveHosts.find((entry) => entry.hostId === hostId);
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
              No hosts yet. Create one from the Host tab to populate the
              comparison.
            </p>
          </div>
        ) : (
          <>
            <CompareSearchBar
              query={fieldSearchQuery}
              onQueryChange={setFieldSearchQuery}
              matchCount={matchCount}
              totalCount={totalFieldCount}
              showCount={orderedSubjects.length > 0}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />

            <HostCompareSelector
              hosts={hosts}
              selectedHostIds={selectedHostIds}
              subjectsByHost={allSubjects}
              onToggleHost={handleToggleHost}
              divergingOnly={divergingOnly}
              onDivergingOnlyChange={setDivergingOnly}
              supportFilter={supportFilter}
              onSupportFilterChange={setSupportFilter}
              showDescriptions={showDescriptions}
              onShowDescriptionsChange={setShowDescriptions}
              disabled={listLoading}
              themeMode={themeMode}
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
                {viewMode === "table" ? (
                  <HostConfigComparisonMatrix
                    subjects={orderedSubjects}
                    divergingOnly={divergingOnly}
                    supportFilter={supportFilter}
                    searchQuery={fieldSearchQuery}
                    showDescriptions={showDescriptions}
                    themeMode={themeMode}
                    onRemoveHost={
                      selectedHostIdSet.size > 1 ? handleToggleHost : undefined
                    }
                  />
                ) : (
                  <HostCapabilityListView
                    subjects={orderedSubjects}
                    divergingOnly={divergingOnly}
                    supportFilter={supportFilter}
                    searchQuery={fieldSearchQuery}
                    themeMode={themeMode}
                  />
                )}
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

/** caniuse-style "Can I use ___" search header + result count + view toggle. */
function CompareSearchBar({
  query,
  onQueryChange,
  matchCount,
  totalCount,
  showCount,
  viewMode,
  onViewModeChange,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  totalCount: number;
  /** Hidden while hosts are still loading — the count would be meaningless. */
  showCount: boolean;
  viewMode: CompareViewMode;
  onViewModeChange: (mode: CompareViewMode) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <span className="shrink-0 text-[15px] font-medium tracking-tight text-foreground">
        Can I use…
      </span>
      <SearchInput
        value={query}
        onValueChange={onQueryChange}
        placeholder="Search capabilities, fields, descriptions…"
        aria-label="Search host config fields"
        className="order-last w-full sm:order-none sm:w-auto sm:min-w-[240px] sm:flex-1"
      />
      {showCount && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {matchCount} / {totalCount} fields
        </span>
      )}
      <div
        role="group"
        aria-label="View mode"
        className="flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5"
      >
        {(
          [
            { value: "table", label: "Tables" },
            { value: "list", label: "List" },
          ] as const
        ).map((v) => {
          const active = viewMode === v.value;
          return (
            <button
              key={v.value}
              type="button"
              aria-pressed={active}
              data-testid={`compare-view-${v.value}`}
              onClick={() => onViewModeChange(v.value)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                active
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      {label}
    </div>
  );
}
