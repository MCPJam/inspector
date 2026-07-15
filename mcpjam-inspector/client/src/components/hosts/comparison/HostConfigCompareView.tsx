import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Bell, Check, Copy, Filter, Flag, Loader2, Share2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@mcpjam/design-system/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Textarea } from "@mcpjam/design-system/textarea";
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
import { useCodexHostEnabled } from "@/hooks/useCodexHostEnabled";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import type {
  HostComparisonSubject,
  HostConfigFieldDef,
} from "@/lib/host-config-field-schema";
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
import {
  PUBLIC_CAN_I_USE_FIELDS,
  getCaniuseCapabilityBySlug,
  getCaniuseCapabilityForField,
  sortCaniusePresetHosts,
} from "./caniuse-capability-catalog";
import { HostConfigComparisonMatrix } from "./host-config-comparison-matrix";
import { HostCapabilityListView } from "./HostCapabilityListView";
import {
  fieldMatchesQuery,
  type SupportFilterMode,
} from "./support-level";
import {
  groupHostConfigFields,
  HOST_CONFIG_FIELDS,
} from "@/lib/host-config-field-schema";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";

type CompareViewMode = "table" | "list";

const HOSTS_QUERY_PARAM = "hosts";
const CAPABILITY_QUERY_PARAM = "capability";
const SEARCH_QUERY_PARAM = "q";
const MAIN_PRODUCT_URL = "https://app.mcpjam.com";
const MOBILE_COMPARE_MEDIA_QUERY = "(max-width: 640px)";
const CANIUSE_ACTION_BUTTON_CLASS =
  "h-8 rounded-full border-border bg-background px-3 text-[12px] font-medium text-foreground hover:border-border hover:bg-muted hover:text-foreground";
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

function normalizeSearchParamValue(value: string): string {
  return value.trim().toLowerCase();
}

function capabilityForSearchQuery(
  query: string,
  fields: ReadonlyArray<HostConfigFieldDef>
) {
  const normalized = normalizeSearchParamValue(query);
  if (!normalized) return null;

  for (const field of fields) {
    const capability = getCaniuseCapabilityForField(field);
    if (!capability) continue;
    const shortFieldId = field.id.replace(/^capabilities\./, "");
    const exactMatches = [
      field.label,
      capability.slug,
      field.id,
      shortFieldId,
    ].map(normalizeSearchParamValue);
    if (exactMatches.includes(normalized)) return capability;
  }

  return null;
}

function fieldSearchQueryFromParams(searchParams: URLSearchParams): string {
  const capability = getCaniuseCapabilityBySlug(
    searchParams.get(CAPABILITY_QUERY_PARAM)
  );
  if (capability) return capability.field.label;
  return searchParams.get(SEARCH_QUERY_PARAM) ?? "";
}

function writeFieldSearchParams(
  next: URLSearchParams,
  query: string,
  fields: ReadonlyArray<HostConfigFieldDef>
) {
  const trimmed = query.trim();
  next.delete(CAPABILITY_QUERY_PARAM);
  next.delete(SEARCH_QUERY_PARAM);
  if (!trimmed) return;

  const capability = capabilityForSearchQuery(trimmed, fields);
  if (capability) {
    next.set(CAPABILITY_QUERY_PARAM, capability.slug);
    return;
  }

  next.set(SEARCH_QUERY_PARAM, trimmed);
}

/**
 * Absolute, shareable URL for the current comparison. Unlike the URL the view
 * mirrors into (which drops `hosts=` for the default selection to keep the bar
 * clean), a shared link always pins the exact clients — so it opens the same
 * comparison for the recipient even if the default set changes later.
 */
function buildShareComparisonUrl(
  hostIds: ReadonlyArray<string>,
  query: string,
  fields: ReadonlyArray<HostConfigFieldDef>
): string {
  const params = new URLSearchParams();
  if (hostIds.length > 0) {
    params.set(HOSTS_QUERY_PARAM, hostIds.join(","));
  }
  writeFieldSearchParams(params, query, fields);
  const search = params.toString();
  if (typeof window === "undefined") {
    return search ? `?${search}` : "";
  }
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${search ? `?${search}` : ""}`;
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
  const catalogState = useHostCatalog();
  const compareCatalog = presetOnly
    ? catalogState.catalog ?? bundledHostCompatCatalog()
    : catalogState.catalog;
  const liveHosts = canQueryLiveHosts ? queriedLiveHosts : [];
  const listLoading = canQueryLiveHosts ? queriedListLoading : false;
  const selectionScopeId = presetOnly ? "public" : projectId ?? "";

  // Catalog host profiles (Claude, ChatGPT, Cursor, …) offered as opt-in
  // comparison columns even when the user hasn't created them.
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const codexEnabled = useCodexHostEnabled();
  const excludedPresetTemplateIds = useMemo(() => {
    const excluded = new Set<string>();
    if (!claudeCodeEnabled) excluded.add("claude-code");
    if (!codexEnabled) excluded.add("codex");
    return excluded;
  }, [claudeCodeEnabled, codexEnabled]);
  const presets = useMemo(() => {
    if (!compareCatalog) {
      return { hosts: [], subjects: {} as Record<string, HostComparisonSubject> };
    }
    return buildPresetCompareEntries(compareCatalog, {
        excludedTemplateIds: excludedPresetTemplateIds,
    });
  }, [compareCatalog, excludedPresetTemplateIds]);
  // Real created hosts first, then presets — what the selector chips iterate.
  const hosts = useMemo(() => {
    if (!presetOnly) return [...liveHosts, ...presets.hosts];
    return sortCaniusePresetHosts(presets.hosts);
  }, [liveHosts, presetOnly, presets.hosts]);

  const [subjectsByHost, setSubjectsByHost] = useState<
    Record<string, HostComparisonSubject>
  >({});
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>([]);
  const [divergingOnly, setDivergingOnly] = useState(false);
  const [supportFilter, setSupportFilter] = useState<SupportFilterMode>("all");
  const [fieldSearchQuery, setFieldSearchQuery] = useState(() =>
    fieldSearchQueryFromParams(searchParams)
  );
  const [viewMode, setViewMode] = useState<CompareViewMode>(() =>
    getInitialCompareViewMode()
  );
  const [showDescriptions, setShowDescriptions] = useState(false);
  const viewModeUserSetRef = useRef(false);
  const hasFieldSearchQuery = fieldSearchQuery.trim().length > 0;
  const effectiveSupportFilter = hasFieldSearchQuery ? supportFilter : "all";
  // Tracks whether the initial URL-driven selection has been applied.
  // After the first resolve, subsequent URL changes are ignored — Compare
  // becomes the source of truth and mirrors back into the URL.
  const urlConsumedRef = useRef(false);

  // Real created hosts only — the last-resort fallback inside
  // `resolveInitialHostCompareSelection` if the ChatGPT/Claude presets
  // are ever unavailable. The actual default selection is
  // `DEFAULT_COMPARE_HOST_IDS` (see the ?hosts=-is-default suppression below).
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
  const compareFields = useMemo(
    () => (presetOnly ? PUBLIC_CAN_I_USE_FIELDS : HOST_CONFIG_FIELDS),
    [presetOnly]
  );
  // Base for the per-column "Verify against your server" deep-link. In dev the
  // caniuse surface and the hosted app share an origin, so stay on it (localhost)
  // instead of bouncing to prod; on the prod vanity domain (caniuse.dev) the
  // hosted app is a different origin, so use the absolute product URL.
  const verifyBaseUrl = useMemo(() => {
    if (!presetOnly) return undefined;
    if (import.meta.env.DEV && typeof window !== "undefined") {
      return window.location.origin;
    }
    return MAIN_PRODUCT_URL;
  }, [presetOnly]);

  useEffect(() => {
    const nextQuery = fieldSearchQueryFromParams(searchParams);
    setFieldSearchQuery((previous) =>
      previous === nextQuery ? previous : nextQuery
    );
  }, [searchParams]);

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

  // Mirror selection/search → URL. Suppress `hosts=` when the selection is the
  // default (ChatGPT + Claude, in that order) so shared links stay clean.
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
    // falls back to the ChatGPT/Claude presets, or live hosts if those
    // are unavailable; `toggleHostCompareSelection` keeps `minSelected=1`),
    // so an empty selection means "not yet resolved."
    if (selectedHostIds.length === 0) return;
    const next = new URLSearchParams(searchParams);
    const isDefault =
      selectedHostIds.length === DEFAULT_COMPARE_HOST_IDS.length &&
      selectedHostIds.every((id, i) => id === DEFAULT_COMPARE_HOST_IDS[i]);
    if (isDefault) {
      next.delete(HOSTS_QUERY_PARAM);
    } else {
      next.set(HOSTS_QUERY_PARAM, selectedHostIds.join(","));
    }

    writeFieldSearchParams(next, fieldSearchQuery, compareFields);
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [
    compareFields,
    fieldSearchQuery,
    selectedHostIds,
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

  const handleResetCompareView = useCallback(() => {
    setFieldSearchQuery("");
    setSupportFilter("all");
  }, []);

  useEffect(() => {
    if (hasFieldSearchQuery || supportFilter === "all") return;
    setSupportFilter("all");
  }, [hasFieldSearchQuery, supportFilter]);

  if (!presetOnly && !projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sign in to compare your clients.
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
              {presetOnly
                ? "No hosts are available in the live catalog."
                : "No hosts yet. Create one from the Host tab to populate the comparison."}
            </p>
          </div>
        ) : (
          <>
            <CompareSearchBar
              query={fieldSearchQuery}
              onQueryChange={setFieldSearchQuery}
              fields={compareFields}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              disableListView={showDescriptions}
              mobileOptimized={presetOnly}
              onReset={handleResetCompareView}
              supportFilter={supportFilter}
              onSupportFilterChange={setSupportFilter}
              actions={
                presetOnly ? (
                  <div className="flex items-center gap-1.5">
                    <ReportInconsistencyDialog />
                    <NotifyButton />
                    <ShareComparisonDialog
                      selectedHostIds={selectedHostIds}
                      searchQuery={fieldSearchQuery}
                      fields={compareFields}
                    />
                  </div>
                ) : undefined
              }
            />

            <HostCompareSelector
              hosts={hosts}
              selectedHostIds={selectedHostIds}
              subjectsByHost={allSubjects}
              onToggleHost={handleToggleHost}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              disableListView={showDescriptions}
              divergingOnly={divergingOnly}
              onDivergingOnlyChange={setDivergingOnly}
              supportFilter={supportFilter}
              onSupportFilterChange={setSupportFilter}
              supportFiltersDisabled={!hasFieldSearchQuery}
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
                    fields={compareFields}
                    divergingOnly={divergingOnly}
                    supportFilter={effectiveSupportFilter}
                    searchQuery={fieldSearchQuery}
                    showDescriptions={showDescriptions}
                    themeMode={themeMode}
                    mobileOptimized={presetOnly}
                    onRemoveHost={
                      selectedHostIdSet.size > 1 ? handleToggleHost : undefined
                    }
                    verifyBaseUrl={verifyBaseUrl}
                  />
                ) : (
                  <HostCapabilityListView
                    subjects={orderedSubjects}
                    fields={compareFields}
                    divergingOnly={divergingOnly}
                    supportFilter={effectiveSupportFilter}
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

function NotifyButton() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "succeeded" | "error"
  >("idle");
  const trimmedEmail = email.trim();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    setEmail("");
    setStatus("idle");
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (status === "submitting") return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        setStatus("error");
        return;
      }
      setStatus("submitting");
      try {
        const response = await fetch("/api/web/caniuse/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail }),
        });
        if (!response.ok) throw new Error("Subscribe failed");
        setStatus("succeeded");
      } catch {
        setStatus("error");
      }
    },
    [status, trimmedEmail]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Notify me of client changes"
        title="Notify me of client changes"
        className={cn("gap-1.5", CANIUSE_ACTION_BUTTON_CLASS)}
        onClick={() => setOpen(true)}
      >
        <Bell className="size-3.5" />
        <span>Notify</span>
      </Button>
      <DialogContent className="sm:max-w-[420px]">
        {status === "succeeded" ? (
          <>
            <DialogHeader>
              <DialogTitle>You&apos;re on the list.</DialogTitle>
              <DialogDescription>
                We&apos;ll email you when hosts change.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="size-4 shrink-0" />
              Saved.
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <DialogHeader>
              <DialogTitle>Stay up to date</DialogTitle>
              <DialogDescription>
                Get an email when a host adds or changes a capability.
              </DialogDescription>
            </DialogHeader>
            <div>
              <input
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (status === "error") setStatus("idle");
                }}
                placeholder="you@company.com"
                aria-label="Email"
                autoFocus
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
              {status === "error" ? (
                <p className="mt-1 text-[11px] text-destructive">
                  Enter a valid email address.
                </p>
              ) : null}
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={status === "submitting"}
            >
              {status === "submitting" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Sending
                </>
              ) : (
                "Notify me"
              )}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportInconsistencyDialog() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "succeeded" | "error"
  >("idle");

  const trimmedMessage = message.trim();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    setMessage("");
    setStatus("idle");
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!trimmedMessage || status === "submitting") return;

      setStatus("submitting");
      try {
        const response = await fetch("/api/web/caniuse/report-inconsistency", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmedMessage }),
        });
        if (!response.ok) throw new Error("Report failed");
        setStatus("succeeded");
      } catch {
        setStatus("error");
      }
    },
    [status, trimmedMessage]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Report inconsistency"
        title="Report inconsistency"
        className={cn(
          "gap-1.5",
          CANIUSE_ACTION_BUTTON_CLASS
        )}
        onClick={() => setOpen(true)}
      >
        <Flag className="size-3.5" />
        <span>Report</span>
      </Button>
      <DialogContent className="sm:max-w-[440px]">
        {status === "succeeded" ? (
          <>
            <DialogHeader>
              <DialogTitle>Thanks for the heads up.</DialogTitle>
              <DialogDescription>
                We&apos;ve notified the MCPJam team.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Report inconsistency</DialogTitle>
              <DialogDescription>
                Tell us what looks inconsistent.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label
                htmlFor="caniuse-report-message"
                className="text-sm font-medium text-foreground"
              >
                What looks inconsistent?
              </label>
              <Textarea
                id="caniuse-report-message"
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  if (status === "error") setStatus("idle");
                }}
                placeholder="Example: Claude supports this, but the table says it doesn't."
                className="min-h-[120px] resize-none"
                autoFocus
              />
              {status === "error" ? (
                <p className="text-[12px] text-destructive">
                  Couldn&apos;t send report. Please try again.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={status === "submitting"}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!trimmedMessage || status === "submitting"}
              >
                {status === "submitting" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Sending
                  </>
                ) : (
                  "Send report"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
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

/** caniuse-style "Can I use ___" search header + view toggle. */
const SUPPORT_FILTER_OPTIONS: ReadonlyArray<{
  value: SupportFilterMode;
  label: string;
}> = [
  { value: "all", label: "All fields" },
  { value: "missing", label: "Missing" },
  { value: "partial", label: "Partial" },
  { value: "supported", label: "Full" },
];

/**
 * Support-level filter for the caniuse search line, rendered right after the
 * "?" glyph. Always present; the funnel only takes the accent colour once a
 * non-default filter is applied.
 */
function SupportFilterFunnel({
  supportFilter,
  onSupportFilterChange,
  disabled = false,
}: {
  supportFilter: SupportFilterMode;
  onSupportFilterChange: (mode: SupportFilterMode) => void;
  disabled?: boolean;
}) {
  const active = !disabled && supportFilter !== "all";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Filter fields by support level"
          disabled={disabled}
          title={disabled ? "Search first to filter" : undefined}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground",
            active && "text-primary hover:text-primary"
          )}
        >
          <Filter className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 p-1">
        <div className="px-2 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground/70">
          Show
        </div>
        {SUPPORT_FILTER_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            data-testid={`support-filter-${option.value}`}
            disabled={disabled}
            onClick={() => {
              if (!disabled) onSupportFilterChange(option.value);
            }}
            className="h-8 gap-2 rounded-md px-2 text-[12.5px]"
          >
            {option.label}
            {supportFilter === option.value ? (
              <Check className="ml-auto size-3.5 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CompareSearchBar({
  query,
  onQueryChange,
  fields,
  viewMode,
  onViewModeChange,
  disableListView = false,
  mobileOptimized = false,
  onReset,
  actions,
  supportFilter,
  onSupportFilterChange,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  fields: ReadonlyArray<HostConfigFieldDef>;
  viewMode: CompareViewMode;
  onViewModeChange: (mode: CompareViewMode) => void;
  disableListView?: boolean;
  mobileOptimized?: boolean;
  onReset?: () => void;
  /** Utility actions rendered at the trailing edge of the search row. */
  actions?: ReactNode;
  supportFilter?: SupportFilterMode;
  onSupportFilterChange?: (mode: SupportFilterMode) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const searchAnchorRef = useRef<HTMLDivElement | null>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const mcpJamLogoSrc =
    themeMode === "dark" ? "/mcp_jam_dark.png" : "/mcp_jam_light.png";
  const fieldGroups = useMemo(
    () =>
      groupHostConfigFields(
        fields.filter((field) => !SEARCH_PICKER_HIDDEN_FIELD_IDS.has(field.id))
      ),
    [fields]
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

  const handleResetClick = useCallback(() => {
    setPickerOpen(false);
    onReset?.();
  }, [onReset]);

  const canResetSearch = query.trim().length > 0;
  const canIUseLabelClass = mobileOptimized
    ? "shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0 text-[24px] font-semibold leading-none tracking-normal text-foreground transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-100 disabled:hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    : "shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0 text-[15px] font-medium tracking-tight text-foreground transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-100 disabled:hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

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
      {onReset ? (
        <button
          type="button"
          className={canIUseLabelClass}
          aria-label="Show all clients and capabilities"
          disabled={!canResetSearch}
          title={canResetSearch ? "Show all clients and capabilities" : undefined}
          onClick={handleResetClick}
        >
          Can I use…
        </button>
      ) : (
        <span className={canIUseLabelClass}>
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
                aria-label="Search client config fields"
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
                aria-label="Search client config fields"
                className="w-full"
              />
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] p-0"
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
          {supportFilter !== undefined && onSupportFilterChange ? (
            <SupportFilterFunnel
              supportFilter={supportFilter}
              onSupportFilterChange={onSupportFilterChange}
              disabled={query.trim().length === 0}
            />
          ) : null}
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
          {actions ? (
            <div className="flex items-center gap-1.5 sm:col-start-1 sm:row-start-1 sm:justify-self-start">
              {actions}
            </div>
          ) : null}
          <a
            href={MAIN_PRODUCT_URL}
            className="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:col-start-3 sm:row-start-1 sm:justify-self-end"
            aria-label="Open MCPJam"
          >
            <span>Brought to you by</span>
            <img src={mcpJamLogoSrc} alt="MCPJam" className="h-3.5 w-auto" />
          </a>
        </div>
      ) : (
        searchRow
      )}
      {!mobileOptimized && (
        <div
          role="group"
          aria-label="View mode"
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5"
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

function ShareComparisonDialog({
  selectedHostIds,
  searchQuery,
  fields,
}: {
  selectedHostIds: ReadonlyArray<string>;
  searchQuery: string;
  fields: ReadonlyArray<HostConfigFieldDef>;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = useMemo(
    () => buildShareComparisonUrl(selectedHostIds, searchQuery, fields),
    [selectedHostIds, searchQuery, fields]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // Clipboard blocked (e.g. insecure context) — the URL stays visible in
      // the field, so the user can still select and copy it manually.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [shareUrl]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Share"
        title="Share"
        onClick={() => setOpen(true)}
        className={cn(
          "gap-1.5",
          CANIUSE_ACTION_BUTTON_CLASS
        )}
      >
        <Share2 className="size-3.5" />
        <span>Share</span>
      </Button>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Share this comparison</DialogTitle>
          <DialogDescription>
            Anyone with this link will see the same comparison you&apos;re
            looking at.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Shareable link"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11.5px] text-muted-foreground"
            />
            <Button type="button" onClick={handleCopy} className="gap-2">
              {copied ? (
                <>
                  <Check className="size-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-4" />
                  Copy
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
