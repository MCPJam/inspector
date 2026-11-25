import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildCaniuseCapabilitySnapshot } from "@/lib/webmcp/review-surface-snapshots";
import { buildPresetCompareEntries } from "./host-compare-presets";
import {
  buildCaniuseCapabilityPath,
  CANIUSE_TASKS,
  caniuseFieldHasPresetData,
  getCaniuseCapabilityBySlug,
  getCaniuseCapabilityForField,
  publicCaniuseFieldsWithData,
  sortCaniusePresetHosts,
  type CaniuseCapability,
} from "./caniuse-capability-catalog";
import {
  caniuseTitle,
  capabilityCoverage,
  capabilitySlices,
  eventsSupportSummary,
  sliceLabel,
} from "./caniuse-coverage";
import { CaniuseSite } from "./CaniuseSite";
import {
  ClientMap,
  CapabilityReference,
  capabilityResultLabel,
} from "./CaniuseClientMap";
import { CaniuseShareDialog } from "./CaniuseShareDialog";

const GROUPS = [
  "Base protocol",
  "Client features",
  "Server features",
  "Extensions",
  "Agent behavior",
  "MCP Apps details",
];
const EXTENSIONS = [
  "capabilities.uiExtension",
  "mcpTasks",
  "capabilities.skillsExtension",
  "eventsDeliveryModes",
];
const SOURCES: Record<string, string> = {
  eventsDeliveryModes:
    "https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md",
  mcpTasks:
    "https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663",
  "capabilities.uiExtension":
    "https://modelcontextprotocol.io/extensions/apps/overview",
  "capabilities.skillsExtension":
    "https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640",
};

function groupCapability({ field }: CaniuseCapability) {
  if (EXTENSIONS.includes(field.id)) return "Extensions";
  if (field.section === "apps") return "MCP Apps details";
  if (field.section === "agent") return "Agent behavior";
  if (
    field.id.startsWith("capabilities.") ||
    field.id.startsWith("roots") ||
    field.id.startsWith("sampling") ||
    field.id.startsWith("elicitation")
  )
    return "Client features";
  if (
    field.id.startsWith("tool") ||
    field.id.startsWith("resource") ||
    field.id.startsWith("prompt")
  )
    return "Server features";
  return "Base protocol";
}

export function CaniuseCapabilityPage({
  capabilitySlug,
}: {
  capabilitySlug: string | null | undefined;
}) {
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
  const capabilities = useMemo(() => {
    const entries = publicCaniuseFieldsWithData(subjects).flatMap((field) => {
      const capability = getCaniuseCapabilityForField(field);
      return capability ? [capability] : [];
    });
    return [...entries, CANIUSE_TASKS];
  }, [subjects]);
  const resolved = getCaniuseCapabilityBySlug(capabilitySlug);
  const capability =
    resolved &&
    (resolved === CANIUSE_TASKS ||
      caniuseFieldHasPresetData(resolved.field, subjects))
      ? resolved
      : null;
  const [params, setParams] = useSearchParams();
  const slices = capability ? capabilitySlices(capability.field, clients) : [];
  const requested = params.get("slice") ?? "";
  const selected = slices.includes(requested) ? requested : "";
  const view = params.get("view") === "reference" ? "reference" : "map";
  const coverage = useMemo(
    () =>
      capability
        ? capabilityCoverage(capability.field, clients, selected)
        : null,
    [capability, clients, selected],
  );
  const title = capability
    ? caniuseTitle(capability.field)
    : "Capability not found";
  const coverageLabel = coverage?.eventsMode
    ? "Support among clients with results"
    : coverage?.reporting
      ? "Reporting coverage"
      : "Client adoption";
  const activeGroup = capability ? groupCapability(capability) : "Extensions";

  useSurfaceAgentBridge({
    surfaceId: "host-compare",
    snapshot: () =>
      buildCaniuseCapabilitySnapshot({
        capabilitySlug: capability?.slug,
        capabilityLabel: capability ? title : null,
        slice: selected && selected !== "any" ? selected : null,
        rows:
          coverage?.rows.map(({ subject, status }) => ({
            hostName: subject.hostName,
            supportLevel: status,
            supportLabel: capabilityResultLabel(
              status,
              capability?.field.id,
              coverage,
            ),
          })) ?? [],
      }),
  });

  function select(key: "view" | "slice", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }

  return (
    <CaniuseSite current="capabilities">
      <div className="grid gap-6 py-6 md:grid-cols-[232px_minmax(0,1fr)] lg:gap-10 lg:py-8">
        <nav
          aria-label="Browse capabilities"
          className="min-w-0 self-start rounded-xl border border-border bg-card text-card-foreground md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:overflow-auto"
        >
          {GROUPS.map((group) => {
            const entries = capabilities.filter(
              (entry) => groupCapability(entry) === group,
            );
            if (!entries.length) return null;
            if (group === "Extensions")
              entries.sort(
                (a, b) =>
                  EXTENSIONS.indexOf(a.field.id) -
                  EXTENSIONS.indexOf(b.field.id),
              );
            return (
              <details
                key={group}
                open={group === activeGroup}
                className="group border-b border-border last:border-b-0"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-muted focus-visible:outline-ring">
                  {group}{" "}
                  <ChevronDown className="size-3.5 text-muted-foreground group-open:rotate-180" />
                </summary>
                <div className="grid gap-0.5 px-2 pb-2">
                  {entries.map(({ slug, field }) => (
                    <Link
                      key={slug}
                      to={buildCaniuseCapabilityPath(slug)}
                      aria-current={
                        slug === capability?.slug ? "page" : undefined
                      }
                      className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-primary/15 aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
                    >
                      {caniuseTitle(field)}
                    </Link>
                  ))}
                </div>
              </details>
            );
          })}
        </nav>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <h1 className="break-words text-3xl font-semibold tracking-tight sm:text-4xl">
              {title}
            </h1>
            {capability && coverage && (
              <CaniuseShareDialog
                key={`${capability.slug}/${selected}`}
                title={title}
                slug={capability.slug}
                slice={selected}
                coverage={coverage}
              />
            )}
          </div>
          {capability && coverage ? (
            <>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {capability.field.description}
                {SOURCES[capability.field.id] && (
                  <>
                    {" "}
                    <a
                      className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-primary/70 underline-offset-4"
                      href={SOURCES[capability.field.id]}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {capability.field.id === "eventsDeliveryModes"
                        ? "Read proposal"
                        : "Read specification"}{" "}
                      <ArrowUpRight className="size-3" />
                    </a>
                  </>
                )}
              </p>
              <section
                aria-label={coverageLabel}
                className="caniuse-glow mt-6 overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
              >
                <div className="px-5 py-6 sm:px-7 sm:py-7">
                  <p className="text-sm font-medium text-muted-foreground">
                    {coverageLabel}
                  </p>
                  <div className="mt-2 text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl">
                    {coverage.score === null ? "—" : `${coverage.score}%`}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {coverage.score === null
                      ? "No published client results yet."
                      : coverage.eventsMode
                        ? eventsSupportSummary(coverage)
                        : coverage.reporting
                          ? `${coverage.full} of ${coverage.measured} tracked clients report a value.`
                          : `${coverage.full} of ${coverage.measured} clients with published results fully support this capability.`}
                  </p>
                  {coverage.eventsMode && coverage.score !== null && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {coverage.measured} of {coverage.rows.length} tracked clients
                      have published results.
                    </p>
                  )}
                </div>
                {slices.length > 0 && (
                  <div
                    className="flex flex-wrap gap-2 border-t border-border px-4 py-3 sm:px-6"
                    role="group"
                    aria-label="Coverage breakdown"
                  >
                    {(slices.includes("any") ? slices : ["", ...slices]).map(
                      (slice) => {
                        const active =
                          (selected ||
                            (slices.includes("any") ? "any" : "")) === slice;
                        return (
                          <Button
                            key={slice}
                            variant={active ? "secondary" : "outline"}
                            size="sm"
                            aria-pressed={active}
                            onClick={() =>
                              select("slice", slice === "any" ? "" : slice)
                            }
                          >
                            {slice ? sliceLabel(slice) : "All versions"}
                          </Button>
                        );
                      },
                    )}
                  </div>
                )}
              </section>
              <div className="my-5 flex flex-wrap items-center justify-between gap-3">
                <div
                  className="flex gap-1 rounded-lg border border-border bg-card p-1 text-card-foreground"
                  role="group"
                  aria-label="Coverage view"
                >
                  <Button
                    variant={view === "map" ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={view === "map"}
                    onClick={() => select("view", "")}
                  >
                    Client map
                  </Button>
                  <Button
                    variant={view === "reference" ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={view === "reference"}
                    onClick={() => select("view", "reference")}
                  >
                    Reference table
                  </Button>
                </div>
                <Button asChild variant="ghost" size="sm">
                  <a href="https://app.mcpjam.com">
                    Verify against your server{" "}
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </Button>
              </div>
              {view === "map" ? (
                <ClientMap coverage={coverage} />
              ) : (
                <CapabilityReference
                  coverage={coverage}
                  field={capability.field}
                  slice={selected}
                />
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Choose a capability from the list.
            </p>
          )}
        </div>
      </div>
    </CaniuseSite>
  );
}
