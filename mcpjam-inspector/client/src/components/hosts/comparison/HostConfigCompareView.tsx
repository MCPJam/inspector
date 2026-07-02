import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@mcpjam/design-system/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import { useSearchParams } from "react-router";
import { useHost, useHostList } from "@/hooks/useClients";
import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import type {
  HostComparisonSubject,
  HostConfigFieldDef,
} from "@/lib/host-config-field-schema";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { HostCompareSelector } from "./HostCompareSelector";
import {
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
  fieldMatchesQuery,
  isSupportField,
  type SupportFilterMode,
} from "./support-level";
import {
  groupHostConfigFields,
  HOST_CONFIG_FIELDS,
  hostConfigField,
} from "@/lib/host-config-field-schema";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";

type CompareViewMode = "table" | "list";

const HOSTS_QUERY_PARAM = "hosts";
const MAIN_PRODUCT_URL = "https://app.mcpjam.com";
const MOBILE_COMPARE_MEDIA_QUERY = "(max-width: 640px)";
const SEARCH_PICKER_HIDDEN_FIELD_IDS = new Set([
  "modelId",
  "systemPrompt",
  "temperature",
]);

function getInitialCompareViewMode(): CompareViewMode {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "table";
  }
  return window.matchMedia(MOBILE_COMPARE_MEDIA_QUERY).matches
    ? "list"
    : "table";
}

function sameStringArray(a: ReadonlyArray<string>, b: ReadonlyArray<string>) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface HostConfigCompareViewProps {
  projectId: string | null;
  isAuthenticated: boolean;
  /**
   * Public caniuse.dev embed mode: compare only static preset host profiles.
   * The full MCPJam app keeps live project hosts available.
   */
  presetOnly?: boolean;
}

/**
 * Top-level container for `/clients/compare`. Loads every host in the
 * project, lets the user pick which ones appear as columns, and renders
 * their hydrated `HostConfigDtoV2` side by side.
 */
export function HostConfigCompareView({
  projectId,
  isAuthenticated,
  presetOnly = false,
}: HostConfigCompareViewProps) {
  const canQueryLiveHosts =
    !presetOnly && isAuthenticated && shouldQueryProjectId(projectId);
  const { hosts: queriedLiveHosts, isLoading: queriedListLoading } =
    useHostList({
      isAuthenticated: canQueryLiveHosts,
      projectId,
    });
  const liveHosts = canQueryLiveHosts ? queriedLiveHosts : [];
  const listLoading = canQueryLiveHosts ? queriedListLoading : false;
  const selectionScopeId = presetOnly ? "public" : projectId ?? "";

  // Static host profiles (Claude, ChatGPT, Cursor, …) offered as opt-in
  // comparison columns even when the user hasn't created them — the same
  // best-effort profiles the server detail modal's Hosts tab renders. Threaded
  // with the current theme so preset configs match the rest of the app.
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const excludedPresetTemplateIds = useMemo(() => {
    const excluded = new Set<"claude-code">();
    if (!claudeCodeEnabled) excluded.add("claude-code");
    return excluded;
  }, [claudeCodeEnabled]);
  const presets = useMemo(
    () =>
      buildPresetCompareEntries(themeMode, {
        excludedTemplateIds: excludedPresetTemplateIds,
      }),
    [themeMode, excludedPresetTemplateIds]
  );

  // Real created hosts first, then presets — what the selector chips iterate.
  const hosts = useMemo(
    () => (presetOnly ? presets.hosts : [...liveHosts, ...presets.hosts]),
    [liveHosts, presetOnly, presets.hosts]
  );

  const [subjectsByHost, setSubjectsByHost] = useState<
    Record<string, HostComparisonSubject>
  >({});
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>([]);
  const [divergingOnly, setDivergingOnly] = useState(false);
  const [supportFilter, setSupportFilter] = useState<SupportFilterMode>("all");
  const [fieldSearchQuery, setFieldSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<CompareViewMode>(() =>
    getInitialCompareViewMode()
  );
  const [showDescriptions, setShowDescriptions] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const viewModeUserSetRef = useRef(false);
  // Tracks whether the initial URL-driven selection has been applied.
  // After the first resolve, subsequent URL changes are ignored — Compare
  // becomes the source of truth and mirrors back into the URL.
  const urlConsumedRef = useRef(false);

  // Real created hosts drive the default selection in the full app. Public
  // preset-only compare defaults to presets so caniuse.dev renders without auth.
  const liveHostIds = useMemo(
    () => liveHosts.map((host) => host.hostId),
    [liveHosts]
  );
  const presetHostIds = useMemo(
    () => presets.hosts.map((host) => host.hostId),
    [presets.hosts]
  );
  const defaultHostIds = useMemo(
    () => (presetOnly ? presetHostIds : liveHostIds),
    [liveHostIds, presetHostIds, presetOnly]
  );
  // Every selectable id (real + preset). URL / stored selections reconcile
  // against this so a chosen preset column survives a reload.
  const knownHostIds = useMemo(() => hosts.map((host) => host.hostId), [hosts]);

  useEffect(() => {
    if (!presetOnly && !projectId) return;
    if (listLoading) return;
    const urlSelection = urlConsumedRef.current
      ? null
      : parseHostsParam(searchParams.get(HOSTS_QUERY_PARAM));
    urlConsumedRef.current = true;
    setSelectedHostIds((previous) => {
      const next = resolveInitialHostCompareSelection({
        projectId: selectionScopeId,
        liveHostIds: defaultHostIds,
        knownHostIds,
        previousSelection: previous,
        urlSelection,
      });
      return sameStringArray(previous, next) ? previous : next;
    });
  }, [
    defaultHostIds,
    knownHostIds,
    listLoading,
    presetOnly,
    projectId,
    searchParams,
    selectionScopeId,
  ]);

  useEffect(() => {
    if (!presetOnly && !projectId) return;
    if (selectedHostIds.length === 0) return;
    writeHostCompareSelection(selectionScopeId, selectedHostIds);
  }, [presetOnly, projectId, selectionScopeId, selectedHostIds]);

  // Mirror selection → ?hosts=. Suppress when the selection is the default
  // "all live hosts" (in original order) so shared links stay clean.
  useEffect(() => {
    if (!presetOnly && !projectId) return;
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
      selectedHostIds.length === defaultHostIds.length &&
      selectedHostIds.every((id, i) => id === defaultHostIds[i]);
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
  }, [
    selectedHostIds,
    defaultHostIds,
    listLoading,
    presetOnly,
    projectId,
    searchParams,
    setSearchParams,
  ]);

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
    []
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
    [selectedHostIds]
  );

  // Preset subjects are static and available immediately; fetched real-host
  // subjects (keyed by Convex id, no prefix collision) layer on top.
  const allSubjects = useMemo(
    () => ({ ...presets.subjects, ...subjectsByHost }),
    [presets.subjects, subjectsByHost]
  );

  const orderedSubjects = useMemo(() => {
    return selectedHostIds
      .map((hostId) => allSubjects[hostId])
      .filter(
        (subject): subject is HostComparisonSubject => subject !== undefined
      );
  }, [selectedHostIds, allSubjects]);

  const loadedSelectedCount = orderedSubjects.length;
  const totalSelectedCount = selectedHostIds.length;
  const allSelectedLoaded =
    !listLoading && loadedSelectedCount === totalSelectedCount;

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const media = window.matchMedia(MOBILE_COMPARE_MEDIA_QUERY);
    const syncModeToViewport = () => {
      if (viewModeUserSetRef.current) return;
      setViewMode(media.matches ? "list" : "table");
    };

    syncModeToViewport();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", syncModeToViewport);
      return () => media.removeEventListener("change", syncModeToViewport);
    }

    media.addListener(syncModeToViewport);
    return () => media.removeListener(syncModeToViewport);
  }, []);

  const handleToggleHost = useCallback((hostId: string) => {
    setSelectedHostIds((previous) =>
      toggleHostCompareSelection(previous, hostId)
    );
  }, []);

  const handleViewModeChange = useCallback(
    (mode: CompareViewMode) => {
      if (mode === "list" && showDescriptions) return;
      viewModeUserSetRef.current = true;
      setViewMode(mode);
    },
    [showDescriptions]
  );

  const handleShowDescriptionsChange = useCallback((enabled: boolean) => {
    setShowDescriptions(enabled);
    if (enabled) {
      viewModeUserSetRef.current = true;
      setViewMode("table");
    }
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
  }, [
    orderedSubjects,
    divergingOnly,
    supportFilter,
    fieldSearchQuery,
    viewMode,
  ]);

  const totalFieldCount = useMemo(
    () =>
      viewMode === "list"
        ? HOST_CONFIG_FIELDS.filter(isSupportField).length
        : HOST_CONFIG_FIELDS.length,
    [viewMode]
  );

  if (!presetOnly && !projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to compare your hosts.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-background",
        presetOnly && "min-w-0 overflow-hidden"
      )}
    >
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

      <div
        className={cn(
          presetOnly
            ? "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-3 pt-1 sm:px-4 sm:pb-4 sm:pt-2 md:px-6 md:pb-6 md:pt-2"
            : "min-h-0 flex-1 overflow-auto p-4 md:p-8"
        )}
      >
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
              onViewModeChange={handleViewModeChange}
              disableListView={showDescriptions}
              mobileOptimized={presetOnly}
            />

            <HostCompareSelector
              hosts={hosts}
              selectedHostIds={selectedHostIds}
              subjectsByHost={allSubjects}
              onToggleHost={handleToggleHost}
              matchCount={matchCount}
              totalCount={totalFieldCount}
              showCount={orderedSubjects.length > 0}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              disableListView={showDescriptions}
              divergingOnly={divergingOnly}
              onDivergingOnlyChange={setDivergingOnly}
              supportFilter={supportFilter}
              onSupportFilterChange={setSupportFilter}
              showDescriptions={showDescriptions}
              onShowDescriptionsChange={handleShowDescriptionsChange}
              descriptionsDisabled={viewMode === "list"}
              disabled={listLoading}
              themeMode={themeMode}
              mobileOptimized={presetOnly}
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
                    mobileOptimized={presetOnly}
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
                    mobileOptimized={presetOnly}
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
  disableListView = false,
  mobileOptimized = false,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  totalCount: number;
  /** Hidden while hosts are still loading — the count would be meaningless. */
  showCount: boolean;
  viewMode: CompareViewMode;
  onViewModeChange: (mode: CompareViewMode) => void;
  disableListView?: boolean;
  mobileOptimized?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const searchAnchorRef = useRef<HTMLDivElement | null>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const mcpJamLogoSrc =
    themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png";
  const fieldGroups = useMemo(
    () =>
      groupHostConfigFields(
        HOST_CONFIG_FIELDS.filter(
          (field) => !SEARCH_PICKER_HIDDEN_FIELD_IDS.has(field.id)
        )
      ),
    []
  );
  const filteredFieldGroups = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();
    return fieldGroups
      .map((group) => ({
        ...group,
        subsections: group.subsections
          .map((subsection) => ({
            ...subsection,
            fields: subsection.fields.filter((field) =>
              fieldMatchesQuery(field, loweredQuery)
            ),
          }))
          .filter((subsection) => subsection.fields.length > 0),
      }))
      .filter((group) => group.subsections.length > 0);
  }, [fieldGroups, query]);

  const handleSelectField = useCallback(
    (field: HostConfigFieldDef) => {
      onQueryChange(field.label);
      setPickerOpen(false);
    },
    [onQueryChange]
  );

  const keepPickerOpenForSearchAnchor = useCallback(
    (event: CustomEvent<{ originalEvent?: Event }>) => {
      const target = (event.detail.originalEvent?.target ??
        event.target) as Node | null;
      if (target && searchAnchorRef.current?.contains(target)) {
        event.preventDefault();
      }
    },
    []
  );

  const searchRow = (
    <>
      {mobileOptimized ? (
        <span className="shrink-0 text-[24px] font-semibold leading-none tracking-normal text-foreground">
          Can I use…
        </span>
      ) : (
        <span className="shrink-0 text-[15px] font-medium tracking-tight text-foreground">
          Can I use…
        </span>
      )}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverAnchor asChild>
          <div
            ref={searchAnchorRef}
            className={cn(
              mobileOptimized
                ? "min-w-0 max-w-full flex-1"
                : "order-last w-full sm:order-none sm:w-auto sm:min-w-[240px] sm:flex-1"
            )}
          >
            {mobileOptimized ? (
              <input
                value={query}
                onChange={(event) => {
                  onQueryChange(event.target.value);
                  setPickerOpen(true);
                }}
                onFocus={() => setPickerOpen(true)}
                placeholder="Search capabilities, fields, descriptions…"
                aria-label="Search host config fields"
                type="search"
                autoComplete="off"
                spellCheck={false}
                className="h-10 w-full border-0 border-b border-dotted border-muted-foreground/60 bg-transparent px-0 text-center text-sm text-foreground outline-none placeholder:text-center placeholder:text-muted-foreground/60 focus:border-foreground focus:ring-0 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
              />
            ) : (
              <SearchInput
                value={query}
                onValueChange={(next) => {
                  onQueryChange(next);
                  setPickerOpen(true);
                }}
                onFocus={() => setPickerOpen(true)}
                placeholder="Search capabilities, fields, descriptions…"
                aria-label="Search host config fields"
                className="w-full"
              />
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[min(420px,calc(100vw-2rem))] p-0"
          onFocusOutside={keepPickerOpenForSearchAnchor}
          onInteractOutside={keepPickerOpenForSearchAnchor}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Command shouldFilter={false}>
            <CommandList className="max-h-[320px]">
              <CommandEmpty>No matching fields.</CommandEmpty>
              {filteredFieldGroups.map((group) => (
                <CommandGroup
                  key={group.section.id}
                  heading={group.section.label}
                >
                  {group.subsections.map((subsection) =>
                    subsection.fields.map((field) => (
                      <CommandItem
                        key={field.id}
                        value={`${field.label} ${field.id} ${field.path} ${
                          field.subsection
                        } ${field.description ?? ""}`}
                        onSelect={() => handleSelectField(field)}
                        className="items-start py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[13px] font-medium">
                              {field.label}
                            </span>
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {subsection.label}
                            </span>
                          </div>
                          {field.description ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                              {field.description}
                            </p>
                          ) : null}
                        </div>
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {mobileOptimized && (
        <span className="inline-flex shrink-0 items-center gap-2">
          <span
            aria-label="Search MCP client capabilities across default clients"
            tabIndex={0}
            title="Search MCP client capabilities across default clients"
            className="text-[24px] font-semibold leading-none text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            ?
          </span>
        </span>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-center gap-3",
        mobileOptimized && "min-w-0 items-center gap-2"
      )}
    >
      {mobileOptimized ? (
        <div className="flex basis-full flex-col items-center gap-1 pb-2 pt-1 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,720px)_minmax(0,1fr)] sm:items-center sm:gap-2">
          <div className="flex w-full min-w-0 flex-nowrap items-center justify-center gap-2 sm:col-start-2">
            {searchRow}
          </div>
          <a
            href={MAIN_PRODUCT_URL}
            className="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:col-start-3 sm:justify-self-end"
            aria-label="Open MCPJam"
          >
            <span>Brought to you by</span>
            <img
              src={mcpJamLogoSrc}
              alt="MCPJam"
              className="h-3.5 w-auto"
            />
          </a>
        </div>
      ) : (
        searchRow
      )}
      {showCount && !mobileOptimized && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {matchCount} / {totalCount} fields
        </span>
      )}
      {!mobileOptimized && (
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
            const disabled = v.value === "list" && disableListView;
            return (
              <button
                key={v.value}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                title={
                  disabled
                    ? "Turn descriptions off before switching to list view"
                    : undefined
                }
                data-testid={`compare-view-${v.value}`}
                onClick={() => onViewModeChange(v.value)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      )}
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
