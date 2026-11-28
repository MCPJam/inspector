import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { HostComparisonSubject, HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { Switch } from "@mcpjam/design-system/switch";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { useIsMobile } from "@/hooks/use-mobile";
import { FLAG_GATED_HOST_IDS } from "@/lib/host-compat/feature-visibility";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildHostCompareSnapshot } from "@/lib/webmcp/review-surface-snapshots";
import { buildPresetCompareEntries } from "./host-compare-presets";
import {
  parseHostsParam,
  reconcileHostCompareSelection,
} from "./host-compare-selection";
import {
  CANIUSE_TASKS,
  publicCaniuseFieldsWithData,
  sortCaniusePresetHosts,
} from "./caniuse-capability-catalog";
import { CaniuseCompareIntro } from "./CaniuseCompareIntro";
import { buildCaniuseMatrixFields } from "./caniuse-matrix-fields";
import { buildCaniuseSummaries, caniuseAdoptionColumn } from "./caniuse-adoption-column";
import { CaniuseClientPicker } from "./CaniuseClientPicker";
import { CaniuseSite } from "./CaniuseSite";
import { HostConfigComparisonMatrix } from "./host-config-comparison-matrix";
import { fieldSearchQueryFromParams, ShareComparisonDialog } from "./HostConfigCompareView";
import { CaniuseCapabilitySearch } from "./CaniuseCapabilitySearch";

const DEFAULT_CLIENTS = ["preset:claude", "preset:chatgpt", "preset:cursor"];

export function CaniuseComparePage() {
  const { catalog } = useHostCatalog();
  const source = catalog ?? bundledHostCompatCatalog();
  const { hosts, subjects } = useMemo(
    () => buildPresetCompareEntries(source),
    [source],
  );
  const clients = useMemo(
    () => sortCaniusePresetHosts(hosts).map(({ hostId }) => subjects[hostId]),
    [hosts, subjects],
  );
  const fields = useMemo(
    () => [...publicCaniuseFieldsWithData(subjects), CANIUSE_TASKS.field],
    [subjects],
  );
  const { params, query, updateQuery, updateSelection } = useCompareParams();
  const location = useLocation();
  const known = new Set(clients.map(({ hostId }) => hostId));
  const pinnedIds = reconcileHostCompareSelection(
    parseHostsParam(params.get("hosts")) ?? [],
    known,
  );
  const defaults = reconcileHostCompareSelection(DEFAULT_CLIENTS, known);
  const selectedIds =
    params.get("hosts") === ""
      ? []
      : pinnedIds.length
        ? pinnedIds
        : defaults.length
          ? defaults
          : [...known].slice(0, 3);
  const selected = selectedIds.map((id) => subjects[id]);
  const summaries = useMemo(() => buildCaniuseSummaries(fields, clients), [fields, clients]);
  const protocol = fields.find((field) => field.id === "supportedProtocolVersions");
  const matrixFields = useMemo(
    () => buildCaniuseMatrixFields(fields, protocol, protocol ? summaries.get(protocol.id)?.slices ?? [] : [], query),
    [fields, protocol, summaries, query],
  );
  const summaryColumn = useMemo(() => caniuseAdoptionColumn(summaries, protocol), [summaries, protocol]);

  useSurfaceAgentBridge({
    surfaceId: "host-compare",
    snapshot: () =>
      buildHostCompareSnapshot({
        totalSelectableHosts: clients.length,
        selectedHosts: selected,
        capabilityFields: matrixFields,
        viewMode: "table",
        searchQuery: query,
        supportFilter: "all",
        divergingOnly: false,
        loadedSelectedCount: selected.length,
        totalSelectedCount: selected.length,
      }),
  });

  return (
    <CaniuseCompareIntro eligible={location.key === "default" && !params.size} subjects={subjects}>
      <CaniuseSite current="compare">
        <div className="caniuse-reveal">
          <div className="pb-10 pt-12 sm:pb-14 sm:pt-20">
            <div className="caniuse-hero relative z-50 flex flex-wrap items-baseline gap-x-[0.23em] gap-y-1 font-bold">
              <h1 className="whitespace-nowrap">Can I use</h1>
              <CaniuseCapabilitySearch fields={fields} query={query} onQueryChange={updateQuery} hero />
            </div>
            <p className="caniuse-byline mt-5 text-muted-foreground">
              Compare MCP client support for protocol versions, features, and
              extensions.
            </p>
          </div>
          <CaniuseClientPicker
            clients={clients}
            selected={selected}
            onChange={updateSelection}
          />
          <CaniuseMatrixPanel
            fields={fields}
            matrixFields={matrixFields}
            selected={selected}
            selectedIds={selectedIds}
            query={query}
            updateQuery={updateQuery}
            summaryColumn={summaryColumn}
          />
        </div>
      </CaniuseSite>
    </CaniuseCompareIntro>
  );
}

function useCompareParams() {
  const [params, setParams] = useSearchParams();
  const pendingParams = useRef(params);
  useLayoutEffect(() => {
    pendingParams.current = params;
  }, [params]);
  const query = fieldSearchQueryFromParams(params);
  function updateQuery(value: string) {
    const next = new URLSearchParams(pendingParams.current);
    next.delete("capability");
    if (value) next.set("q", value);
    else next.delete("q");
    pendingParams.current = next;
    // Both controlled inputs read the URL. Commit the new value before
    // React restores the previous input value at the end of the event.
    setParams(next, { replace: true, flushSync: true });
  }

  function updateSelection(ids: string[]) {
    const next = new URLSearchParams(pendingParams.current);
    next.set("hosts", ids.join(","));
    pendingParams.current = next;
    setParams(next);
  }

  return { params, query, updateQuery, updateSelection };
}

function CaniuseMatrixPanel({
  fields, matrixFields, selected, selectedIds, query, updateQuery, summaryColumn,
}: {
  fields: readonly HostConfigFieldDef[];
  matrixFields: readonly HostConfigFieldDef[];
  selected: readonly HostComparisonSubject[];
  selectedIds: readonly string[];
  query: string;
  updateQuery: (query: string) => void;
  summaryColumn: ReturnType<typeof caniuseAdoptionColumn>;
}) {
  const [showDescriptions, setShowDescriptions] = useState(false);
  const stacked = useIsMobile();
  return (
    <section aria-labelledby="caniuse-matrix-heading" className="min-w-0 rounded-xl border border-border bg-card">
      <div className="relative z-40 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-5">
        <div className="flex basis-full items-center gap-2 sm:basis-auto">
          <h2 id="caniuse-matrix-heading" className="font-bold">
            Capability matrix
          </h2>
          {selected.length > 0 && (
            <ShareComparisonDialog
              selectedHostIds={selectedIds}
              searchQuery={query}
              fields={fields}
              preserveQuery
              copyOnShare
              iconOnly
            />
          )}
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={showDescriptions}
            onCheckedChange={setShowDescriptions}
          />{" "}
          Show descriptions
        </label>
        <CaniuseCapabilitySearch fields={fields} query={query} onQueryChange={updateQuery} />
      </div>
      {selected.length > 0 && (
        <div className="min-w-0 [&>div]:rounded-t-none [&>div]:border-x-0 [&>div]:border-b-0">
          <HostConfigComparisonMatrix
            subjects={selected}
            fields={matrixFields}
            showDescriptions={showDescriptions}
            themeMode="dark"
            mobileOptimized
            stacked={stacked}
            verifyBaseUrl="https://app.mcpjam.com"
            disabledVerifyTemplateIds={FLAG_GATED_HOST_IDS}
            summaryColumn={summaryColumn}
          />
        </div>
      )}
    </section>
  );
}
