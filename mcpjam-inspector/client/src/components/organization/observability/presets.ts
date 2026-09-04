/**
 * Vendor presets, hand-mirrored from `VENDOR_PRESETS` in the backend's
 * `convex/lib/traceDestinationPolicy.ts`. Keep them in sync by hand — nothing
 * checks this at build time, and the two repos release independently.
 *
 * A preset is UI sugar and nothing more: it pre-fills an endpoint, the header
 * NAMES a vendor expects, and the resource attributes it routes on. What comes
 * out is the same generic OTLP/HTTP destination as any other, which is why
 * adding a vendor is a row in this table rather than a code path.
 *
 * Drifting from the backend costs a pre-filled field, never a refusal: the
 * server validates the resulting destination, not the preset it came from.
 */

export const CORALOGIX_REGIONS = [
  "eu1",
  "eu2",
  "us1",
  "us2",
  "us3",
  "ap1",
  "ap2",
  "ap3",
] as const;

export type CoralogixRegion = (typeof CORALOGIX_REGIONS)[number];

export function coralogixIngressUrl(region: CoralogixRegion): string {
  return `https://ingress.${region}.coralogix.com:443`;
}

export interface VendorPreset {
  id: string;
  label: string;
  endpointUrl?: string;
  headerNames: string[];
  suggestedAttributes: string[];
  /** Whether the endpoint is chosen from `CORALOGIX_REGIONS` instead of typed. */
  regional?: boolean;
  compression?: "gzip" | "none";
  /** One line under the picker. Client-only — the backend has no copy. */
  hint?: string;
}

export const VENDOR_PRESETS: readonly VendorPreset[] = [
  {
    id: "coralogix",
    label: "Coralogix",
    headerNames: ["Authorization"],
    suggestedAttributes: ["cx.application.name", "cx.subsystem.name"],
    regional: true,
    compression: "gzip",
    hint: "Authorization takes a Send-Your-Data key as `Bearer <key>`. The two cx.* attributes decide which application and subsystem the spans land under.",
  },
  {
    id: "honeycomb",
    label: "Honeycomb",
    endpointUrl: "https://api.honeycomb.io",
    headerNames: ["x-honeycomb-team"],
    suggestedAttributes: ["service.name"],
  },
  {
    id: "new-relic",
    label: "New Relic",
    endpointUrl: "https://otlp.nr-data.net",
    headerNames: ["api-key"],
    suggestedAttributes: ["service.name"],
  },
  {
    id: "grafana-cloud",
    label: "Grafana Cloud",
    headerNames: ["Authorization"],
    suggestedAttributes: ["service.name", "deployment.environment"],
    hint: "Authorization is `Basic <base64 of instanceID:token>` from your Grafana Cloud OTLP endpoint page.",
  },
  {
    id: "arize-phoenix",
    label: "Arize Phoenix",
    headerNames: ["api_key"],
    suggestedAttributes: ["service.name"],
  },
  {
    id: "otlp",
    label: "OpenTelemetry Collector / other",
    headerNames: [],
    suggestedAttributes: ["service.name", "deployment.environment"],
  },
];

export function presetById(id: string | null | undefined): VendorPreset | null {
  if (!id) return null;
  return VENDOR_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The sources a destination can subscribe to, with the copy that says what
 * each one costs. Order is the order they render in.
 *
 * `direct` is Playground. Only sessions SHARED to the workspace are ever
 * pushed — a private Playground session is excluded in the backend's enqueue
 * and cannot be opted in from here, which the label has to say or an admin
 * will reasonably assume ticking this box exports their own scratch work.
 */
export const SOURCE_TYPE_OPTIONS = [
  {
    id: "eval" as const,
    label: "Evals",
    description: "Every turn of every eval run.",
  },
  {
    id: "scenario" as const,
    label: "Scenarios",
    description: "User-testing scenario sessions.",
  },
  {
    id: "direct" as const,
    label: "Playground (shared)",
    description:
      "Playground sessions shared to the workspace. Private sessions are never sent.",
  },
  {
    id: "swarm" as const,
    label: "Swarms",
    description:
      "High volume — a swarm run is many sessions. Off by default for that reason.",
  },
];
