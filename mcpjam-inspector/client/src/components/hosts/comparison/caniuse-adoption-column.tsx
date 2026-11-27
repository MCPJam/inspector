import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import type { HostComparisonSubject, HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { buildCaniuseCapabilityPath, getCaniuseCapabilityForField } from "./caniuse-capability-catalog";
import { capabilityCoverage, capabilitySlices, eventsSupportSummary, sliceLabel, type CapabilityCoverage } from "./caniuse-coverage";

export function buildCaniuseSummaries(
  fields: readonly HostConfigFieldDef[],
  clients: readonly HostComparisonSubject[],
) {
  return new Map(
    fields.map((field) => [field.id, {
      overall: capabilityCoverage(field, clients),
      slices: capabilitySlices(field, clients)
        .filter((slice) => slice !== "any")
        .map((slice) => ({ slice, coverage: capabilityCoverage(field, clients, slice) })),
    }]),
  );
}

export function caniuseAdoptionColumn(
  summaries: ReturnType<typeof buildCaniuseSummaries>,
  protocol: HostConfigFieldDef | undefined,
) {
  const versions = protocol ? summaries.get(protocol.id)?.slices ?? [] : [];
  const versionScores = new Map(versions.map((version) => [
    `supportedProtocolVersions:${version.slice}`,
    version,
  ]));

  function fieldDestination(field: HostConfigFieldDef) {
    const version = versionScores.get(field.id);
    const capability = getCaniuseCapabilityForField(version && protocol ? protocol : field);
    if (!capability) return null;
    const path = buildCaniuseCapabilityPath(capability.slug);
    return version ? `${path}?slice=${encodeURIComponent(version.slice)}` : path;
  }
  return {
    label: "Client adoption",
    renderFieldLabel: (field: HostConfigFieldDef) => {
      const href = fieldDestination(field);
      return href && (
        <Link to={href} className="rounded-sm hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {field.label}{" "}
          <ArrowUpRight aria-hidden className="inline size-3 text-muted-foreground" />
        </Link>
      );
    },
    render: (field: HostConfigFieldDef) => {
      const version = versionScores.get(field.id);
      const path = fieldDestination(field);
      if (!path) return null;
      const coverage = version?.coverage ?? summaries.get(field.id)?.overall;
      return coverage && <AdoptionLink path={path} coverage={coverage} />;
    },
    renderSlices: (field: HostConfigFieldDef) => {
      if (field.id === protocol?.id) return null;
      const slices = summaries.get(field.id)?.slices;
      if (!slices?.length) return null;
      const path = fieldDestination(field);
      return path && slices.map(({ slice, coverage }) => (
        <AdoptionLink
          key={slice}
          path={`${path}?slice=${encodeURIComponent(slice)}`}
          coverage={coverage}
          label={sliceLabel(slice)}
        />
      ));
    },
  };
}

function AdoptionLink({
  path,
  coverage,
  label,
}: {
  path: string;
  coverage: CapabilityCoverage;
  label?: string;
}) {
  const { full, probed, unpublished, reporting, eventsMode, score } = coverage;
  const percentage = score === null ? "No results" : `${score}%`;
  const detail = score === null
    ? "No results published yet"
    : eventsMode
      ? eventsSupportSummary(coverage)
      : `${full} of ${probed} probed clients ${reporting ? "reported a value" : "have confirmed support"}`;
  const unpublishedLabel = unpublished ? `${unpublished} with no published result` : null;
  const summary = [score === null ? detail : `${percentage}, ${detail}`, unpublishedLabel].filter(Boolean).join(", ");
  return (
    <Link
      to={path}
      aria-label={label ? `${label}: ${summary}` : summary}
      className="w-fit rounded-sm text-xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      title={[detail, unpublishedLabel].filter(Boolean).join(" ")}
    >
      {label && <span className="block font-medium capitalize [overflow-wrap:anywhere]">{label}</span>}
      <span
        className={
          score === null
            ? undefined
            : label
              ? "text-sm font-bold text-primary"
              : "text-base font-bold leading-tight text-primary"
        }
      >
        {percentage}
        {reporting && score !== null && (
          <span className="ml-1 text-xs font-medium">reported</span>
        )}
      </span>
      {score !== null && (
        <span className="ml-1 inline-block">
          {full}/{probed}
        </span>
      )}
      {!label && unpublishedLabel && (
        <span className="block">{unpublishedLabel}</span>
      )}
    </Link>
  );
}
