import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { FLAG_GATED_HOST_IDS } from "@/lib/host-compat/feature-visibility";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildHostCompareSnapshot } from "@/lib/webmcp/review-surface-snapshots";
import { NOT_SUPPORTED, type HostConfigFieldDef } from "@/lib/host-config-field-schema";
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
  ShareComparisonDialog,
} from "./HostConfigCompareView";
import { CaniuseCapabilitySearch, matchesCaniuseQuery } from "./CaniuseCapabilitySearch";

const DEFAULT_CLIENTS = ["preset:claude", "preset:chatgpt", "preset:cursor"];
const INTRO_PROMPTS = [
  { name: "elicitation", clients: ["preset:claude", "preset:cursor"] },
  { name: "MCP Apps", clients: ["preset:chatgpt", "preset:claude"] },
  { name: "Events", clients: ["preset:codex", "preset:chatgpt"] },
];
let introSeen = false;

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
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const pendingParams = useRef(params);
  useLayoutEffect(() => {
    pendingParams.current = params;
  }, [params]);
  const query = fieldSearchQueryFromParams(params);
  const [showDescriptions, setShowDescriptions] = useState(false);
  const reduceMotion = useReducedMotion();
  const [intro, setIntro] = useState(() =>
    !introSeen && location.key === "default" && !params.size && !reduceMotion
      ? 0
      : null,
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
      fields.filter((field) => matchesCaniuseQuery(field, query)),
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
  const protocol = fields.find((field) => field.id === "supportedProtocolVersions");
  const versions = protocol ? summaries.get(protocol.id)?.slices ?? [] : [];
  const matrixFields = fields.flatMap((field) => {
    const matches = matchingFields.includes(field);
    if (field !== protocol || versions.length === 0) {
      return matches ? [{ ...field, label: caniuseTitle(field) }] : [];
    }
    const rows: HostConfigFieldDef[] = [];
    if (matches) {
      rows.push({
        ...field,
        label: caniuseTitle(field),
        kind: { kind: "boolean" },
        read: (config) => {
          const value = field.read(config);
          if (Array.isArray(value)) return value.length > 0;
          return value === NOT_SUPPORTED ? false : undefined;
        },
      });
    }
    for (const { slice } of versions) {
      if (!matches && !slice.includes(query.trim())) continue;
      rows.push({
        ...field,
        id: `${field.id}:${slice}`,
        label: slice,
        description: undefined,
        kind: { kind: "boolean" },
        read: (config) => {
          const value = field.read(config);
          if (Array.isArray(value)) return value.includes(slice);
          return value === NOT_SUPPORTED ? false : undefined;
        },
      });
    }
    return rows;
  });
  const versionScores = new Map(versions.map(({ slice, score }) => [
    `supportedProtocolVersions:${slice}`,
    { slice, score },
  ]));

  function fieldDestination(field: HostConfigFieldDef) {
    const version = versionScores.get(field.id);
    const capability = getCaniuseCapabilityForField(version && protocol ? protocol : field);
    if (!capability) return null;
    const path = buildCaniuseCapabilityPath(capability.slug);
    return version ? `${path}?slice=${encodeURIComponent(version.slice)}` : path;
  }

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

  useEffect(() => {
    if (intro === null || reduceMotion) return;
    introSeen = true;
    const timer = window.setTimeout(() => {
      setIntro(intro + 1 < INTRO_PROMPTS.length ? intro + 1 : null);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [intro, reduceMotion]);

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

  if (intro !== null && !reduceMotion) {
    const prompt = INTRO_PROMPTS[intro];
    return (
      <div className="dark caniuse-site h-full overflow-auto bg-background text-foreground" data-page="compare">
        <div className="caniuse-wrap pt-24 sm:pt-36">
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
    <CaniuseSite current="compare">
      <div className="caniuse-reveal">
        <div className="pb-10 pt-12 sm:pb-14 sm:pt-20">
          <div className="caniuse-hero relative z-10 flex flex-wrap items-baseline gap-x-[0.23em] gap-y-1 font-bold">
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
                verifyBaseUrl="https://app.mcpjam.com"
                disabledVerifyTemplateIds={FLAG_GATED_HOST_IDS}
                summaryColumn={{
                  label: "Client adoption",
                  renderFieldLabel: (field) => {
                    const href = fieldDestination(field);
                    return href && (
                      <Link to={href} className="rounded-sm hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                        {field.label}{" "}
                        <ArrowUpRight aria-hidden className="inline size-3 text-muted-foreground" />
                      </Link>
                    );
                  },
                  render: (field) => {
                    const version = versionScores.get(field.id);
                    if (version) {
                      return (
                        <div className="text-center text-xs font-bold tabular-nums text-primary">
                          {version.score === null ? "No results" : `${version.score}%`}
                        </div>
                      );
                    }
                    const summary = summaries.get(field.id);
                    return (
                      summary && (
                        <MatrixAdoption field={field} summary={summary} />
                      )
                    );
                  },
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
        : `${overall.score}%${overall.reporting ? " reported" : ""}`;
  return (
    <div className="flex flex-col items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
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
      {field.id !== "supportedProtocolVersions" && slices.map(({ slice, score }) => (
        <Link
          key={slice}
          to={`${path}?slice=${encodeURIComponent(slice)}`}
          className="rounded px-1 text-[11px] hover:bg-muted hover:text-foreground"
        >
          {sliceLabel(slice)} {score === null ? "–" : `${score}%`}
        </Link>
      ))}
    </div>
  );
}
