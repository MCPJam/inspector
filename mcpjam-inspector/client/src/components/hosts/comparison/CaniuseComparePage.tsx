import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useReducedMotion } from "framer-motion";
import { Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Switch } from "@mcpjam/design-system/switch";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { useAnnouncementSlot } from "@/components/announcement-slot";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { FLAG_GATED_HOST_IDS } from "@/lib/host-compat/feature-visibility";
import { useServerSupportsFeature } from "@/lib/server-capabilities";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildHostCompareSnapshot } from "@/lib/webmcp/review-surface-snapshots";
import type { HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { buildPresetCompareEntries } from "./host-compare-presets";
import {
  parseHostsParam,
  reconcileHostCompareSelection,
} from "./host-compare-selection";
import {
  buildCaniuseCapabilityPath,
  CANIUSE_TASKS,
  getCaniuseCapabilityForField,
  publicCaniuseFieldsWithData,
  sortCaniusePresetHosts,
} from "./caniuse-capability-catalog";
import {
  caniuseTitle,
  capabilityCoverage,
  capabilitySlices,
  eventsSupportSummary,
  sliceLabel,
} from "./caniuse-coverage";
import { CaniuseClientPicker } from "./CaniuseClientPicker";
import { clientLogo, CaniuseSite } from "./CaniuseSite";
import { HostConfigComparisonMatrix } from "./host-config-comparison-matrix";
import {
  fieldSearchQueryFromParams,
  NotifyButton,
  ReportInconsistencyDialog,
  ShareComparisonDialog,
} from "./HostConfigCompareView";
import { fieldMatchesQuery } from "./support-level";

const DEFAULT_CLIENTS = ["preset:claude", "preset:chatgpt", "preset:cursor"];
const INTRO_PROMPTS = [
  { name: "elicitation", clients: ["preset:claude", "preset:cursor"] },
  { name: "MCP Apps", clients: ["preset:chatgpt", "preset:claude"] },
  { name: "Events", clients: ["preset:codex", "preset:chatgpt"] },
];
let introSeen = false;

export function CaniuseComparePage() {
  const { catalog } = useHostCatalog();
  const publicSiteRelays = useServerSupportsFeature("public-site-relays");
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
  const [params, setParams] = useSearchParams();
  const pendingParams = useRef(params);
  useLayoutEffect(() => {
    pendingParams.current = params;
  }, [params]);
  const query = fieldSearchQueryFromParams(params);
  const [showDescriptions, setShowDescriptions] = useState(false);
  const reduceMotion = useReducedMotion();
  const [intro, setIntro] = useState(() =>
    !introSeen && !params.size && !reduceMotion ? 0 : null,
  );
  const { open: showIntro, contentRef: introRef } = useAnnouncementSlot(
    intro !== null && !params.size && !reduceMotion,
  );
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
  const matchingFields = useMemo(
    () =>
      fields
        .filter(
          (field) =>
            fieldMatchesQuery(field, query) ||
            caniuseTitle(field)
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        )
        .map((field) =>
          caniuseTitle(field) === field.label
            ? field
            : { ...field, label: caniuseTitle(field) },
        ),
    [fields, query],
  );
  const summaries = useMemo(
    () =>
      new Map(
        fields.map((field) => {
          const slices = capabilitySlices(field, clients);
          return [
            field.id,
            {
              overall: capabilityCoverage(field, clients),
              slices: slices
                .filter((slice) => slice !== "any")
                .map((slice) => ({
                  slice,
                  score: capabilityCoverage(field, clients, slice).score,
                })),
            },
          ];
        }),
      ),
    [fields, clients],
  );

  useSurfaceAgentBridge({
    surfaceId: "host-compare",
    snapshot: () =>
      buildHostCompareSnapshot({
        totalSelectableHosts: clients.length,
        selectedHosts: selected,
        capabilityFields: matchingFields,
        viewMode: "table",
        searchQuery: query,
        supportFilter: "all",
        divergingOnly: false,
        loadedSelectedCount: selected.length,
        totalSelectedCount: selected.length,
      }),
  });

  useEffect(() => {
    if (!showIntro || intro === null) return;
    introSeen = true;
    const timer = window.setTimeout(() => {
      setIntro(intro + 1 < INTRO_PROMPTS.length ? intro + 1 : null);
    }, 1050);
    return () => window.clearTimeout(timer);
  }, [intro, showIntro]);

  function updateQuery(value: string) {
    const next = new URLSearchParams(pendingParams.current);
    next.delete("capability");
    if (value) next.set("q", value);
    else next.delete("q");
    pendingParams.current = next;
    setParams(next, { replace: true });
  }

  function updateSelection(ids: string[]) {
    const next = new URLSearchParams(pendingParams.current);
    next.set("hosts", ids.join(","));
    pendingParams.current = next;
    setParams(next);
  }

  if (showIntro && intro !== null) {
    const prompt = INTRO_PROMPTS[intro];
    return (
      <div className="dark caniuse-site h-full overflow-auto bg-background text-foreground" data-page="compare">
        <div ref={introRef} className="caniuse-wrap pt-24 sm:pt-36">
          <div
            className="caniuse-hero flex flex-wrap items-baseline gap-x-[0.23em] gap-y-1 font-bold"
            aria-hidden="true"
          >
            <span className="caniuse-reveal">Can I use</span>
            <span
              key={intro}
              className="caniuse-prompt inline-flex min-w-0 flex-wrap items-center gap-x-[0.21em] gap-y-1"
            >
              <span className="text-primary">{prompt.name}</span> in
              {prompt.clients.map(
                (id) =>
                  subjects[id] && (
                    <img
                      key={id}
                      src={clientLogo(subjects[id])}
                      alt=""
                      className="size-11 rounded-lg border border-border bg-card p-1.5 object-contain sm:size-14"
                    />
                  ),
              )}
              ?
            </span>
          </div>
          <Button
            variant="ghost"
            className="mt-6 text-muted-foreground"
            onClick={() => setIntro(null)}
          >
            Skip intro
          </Button>
        </div>
      </div>
    );
  }

  return (
    <CaniuseSite
      current="compare"
      footer={publicSiteRelays !== false && (
        <>
          <ReportInconsistencyDialog footer />
          <NotifyButton footer />
        </>
      )}
    >
      <div className="caniuse-reveal">
        <div className="pb-10 pt-12 sm:pb-14 sm:pt-20">
          <div className="caniuse-hero flex flex-wrap items-baseline gap-x-[0.23em] gap-y-1 font-bold">
            <h1 className="whitespace-nowrap">Can I use</h1>
            <input
              aria-label="Type a capability"
              placeholder="type a capability…"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              list="caniuse-suggestions"
              className="min-w-0 max-w-[13em] flex-[1_1_9em] border-b border-primary/40 bg-transparent pb-1 text-primary focus-visible:border-ring focus-visible:outline-none"
            />
          </div>
          <p className="mt-5 text-sm text-muted-foreground sm:text-base">
            Compare MCP client support for protocol versions, features, and
            extensions.
          </p>
        </div>
        <CaniuseClientPicker
          clients={clients}
          selected={selected}
          onChange={updateSelection}
        />
        <section aria-labelledby="caniuse-matrix-heading" className="min-w-0 rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-5">
            <h2 id="caniuse-matrix-heading" className="mr-auto basis-full font-bold sm:basis-auto">
              Capability matrix
            </h2>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={showDescriptions}
                onCheckedChange={setShowDescriptions}
              />{" "}
              Show descriptions
            </label>
            <div className="relative min-w-36 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label="Search capabilities"
                placeholder="Search capabilities…"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
                list="caniuse-suggestions"
              />
            </div>
            <datalist id="caniuse-suggestions">
              {fields.map((field) => (
                <option key={field.id} value={caniuseTitle(field)} />
              ))}
            </datalist>
            {selected.length > 0 && (
              <div>
                <ShareComparisonDialog
                  selectedHostIds={selectedIds}
                  searchQuery={query}
                  fields={fields}
                  preserveQuery
                  copyOnShare
                />
              </div>
            )}
          </div>
          {selected.length > 0 && (
            <div className="min-w-0 [&>div]:rounded-t-none [&>div]:border-x-0 [&>div]:border-b-0">
              <HostConfigComparisonMatrix
                subjects={selected}
                fields={matchingFields}
                showDescriptions={showDescriptions}
                themeMode="dark"
                mobileOptimized
                verifyBaseUrl="https://app.mcpjam.com"
                disabledVerifyTemplateIds={FLAG_GATED_HOST_IDS}
                renderFieldSummary={(field) => {
                  const summary = summaries.get(field.id);
                  return (
                    summary && <MatrixAdoption field={field} summary={summary} />
                  );
                }}
              />
            </div>
          )}
        </section>
      </div>
    </CaniuseSite>
  );
}

function MatrixAdoption({
  field,
  summary,
}: {
  field: HostConfigFieldDef;
  summary: {
    overall: ReturnType<typeof capabilityCoverage>;
    slices: { slice: string; score: number | null }[];
  };
}) {
  const capability = getCaniuseCapabilityForField(field);
  if (!capability) return null;
  const path = buildCaniuseCapabilityPath(capability.slug);
  const { overall, slices } = summary;
  const label =
    overall.score === null
      ? "No results"
      : overall.eventsMode
        ? `${overall.score}% of ${overall.measured} with results`
        : `${overall.score}% ${overall.reporting ? "reported" : "adoption"}`;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <Link
        to={path}
        className="font-bold text-primary hover:underline"
        title={
          overall.score === null
            ? "No published results"
            : overall.eventsMode
              ? eventsSupportSummary(overall)
              : `${overall.full} of ${overall.measured} clients ${overall.reporting ? "reported a value" : "support this capability"}`
        }
      >
        {label}
      </Link>
      {slices.map(({ slice, score }) => (
        <Link
          key={slice}
          to={`${path}?slice=${encodeURIComponent(slice)}`}
          className="rounded px-1 hover:bg-muted hover:text-foreground"
        >
          {sliceLabel(slice)} {score === null ? "–" : `${score}%`}
        </Link>
      ))}
    </div>
  );
}
