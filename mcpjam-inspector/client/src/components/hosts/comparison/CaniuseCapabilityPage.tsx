import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
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
import { ClientMap, capabilityResultLabel } from "./CaniuseClientMap";
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
  const navigate = useNavigate();
  const slices = capability ? capabilitySlices(capability.field, clients) : [];
  const requested = params.get("slice") ?? "";
  const selected = slices.includes(requested) ? requested : "";
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

  function selectSlice(value: string) {
    const next = new URLSearchParams(params);
    next.delete("view");
    if (value) next.set("slice", value);
    else next.delete("slice");
    setParams(next);
  }

  const groups = GROUPS.map((name) => ({
    name,
    entries: capabilities.filter((entry) => groupCapability(entry) === name),
  })).filter(({ entries }) => entries.length);
  groups
    .find(({ name }) => name === "Extensions")
    ?.entries.sort(
      (a, b) => EXTENSIONS.indexOf(a.field.id) - EXTENSIONS.indexOf(b.field.id),
    );

  return (
    <CaniuseSite current="capabilities">
      <div className="grid gap-5 py-6 md:grid-cols-[220px_minmax(0,1fr)] lg:gap-8 lg:py-9">
        <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground md:hidden">
          Browse capabilities
          <select
            className="min-h-11 w-full min-w-0 truncate rounded-lg border border-border bg-card px-3 text-sm text-card-foreground"
            value={capability?.slug ?? ""}
            onChange={(event) =>
              navigate(buildCaniuseCapabilityPath(event.target.value))
            }
          >
            {!capability && (
              <option value="" disabled>
                Choose a capability
              </option>
            )}
            {groups.map(({ name, entries }) => (
              <optgroup key={name} label={name}>
                {entries.map(({ slug, field }) => (
                  <option key={slug} value={slug}>
                    {caniuseTitle(field)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <nav
          aria-label="Browse capabilities"
          className="hidden min-w-0 self-start rounded-xl border border-border bg-card text-card-foreground md:sticky md:top-4 md:block md:max-h-[calc(100dvh-2rem)] md:overflow-auto"
        >
          {groups.map(({ name: group, entries }) => (
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
                    className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground"
                  >
                    {caniuseTitle(field)}
                  </Link>
                ))}
                </div>
              </details>
          ))}
        </nav>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 break-words text-3xl font-bold tracking-tight sm:text-4xl">
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
                className="caniuse-glow mt-5 overflow-hidden rounded-xl border border-primary/25 bg-card text-card-foreground"
              >
                <div className="grid sm:grid-cols-2">
                  <div className="px-5 py-5 sm:px-7 sm:py-6">
                    <p className="text-sm font-medium text-muted-foreground">
                      {coverageLabel}
                    </p>
                    <div className="mt-1 text-5xl font-bold tracking-[-0.06em] text-primary tabular-nums sm:text-7xl">
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
                  </div>
                  <div className="border-t border-primary/15 px-5 py-4 sm:border-l sm:border-t-0 sm:px-7 sm:py-6">
                    <p className="text-sm font-medium text-muted-foreground">
                      Published results
                    </p>
                    <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums sm:text-5xl">
                      <span className="text-primary">{coverage.measured}</span>
                      <span className="text-muted-foreground"> / {coverage.rows.length}</span>
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">Tracked clients</p>
                  </div>
                </div>
                {slices.length > 0 && (
                  <div
                    className="flex flex-wrap gap-1.5 border-t border-primary/20 bg-card/85 px-4 py-2 sm:px-7"
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
                            variant="outline"
                            size="sm"
                            className="h-10 bg-muted text-xs aria-pressed:border-primary/65 aria-pressed:bg-accent aria-pressed:text-accent-foreground sm:h-8"
                            aria-pressed={active}
                            onClick={() =>
                              selectSlice(slice === "any" ? "" : slice)
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
              <section
                className="mt-4 rounded-xl border border-border bg-card p-3 sm:p-5"
                aria-labelledby="caniuse-map-heading"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <h2 id="caniuse-map-heading" className="text-xl font-bold tracking-tight">
                    Client map
                  </h2>
                  <Button asChild variant="ghost" size="sm" className="-ml-2 sm:ml-0">
                    <a href="https://app.mcpjam.com">
                      Verify against your server <ArrowUpRight className="size-3.5" />
                    </a>
                  </Button>
                </div>
                <ClientMap coverage={coverage} />
              </section>
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
