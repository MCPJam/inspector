import {
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Plus,
  type LucideIcon,
} from "lucide-react";
import type {
  EvidenceSource,
  FeatureAssessment,
  FeatureDefinition,
  FeatureMarker,
  FeatureNextAction,
  FeatureOwner,
  FeatureStateCounts,
  FeatureUserState,
} from "@mcpjam/sdk/browser";

/**
 * How each user state looks and reads on the canvas. State always reaches
 * the reader as text (`label`, `shortLabel`), never through color alone.
 */
export interface FeatureStateMeta {
  label: string;
  /** Right-hand label on a row. */
  shortLabel: string;
  icon: LucideIcon;
  /** Row surface: tint, outline or de-emphasis. */
  rowClass: string;
  iconClass: string;
  /** Segment fill in the count bar. */
  barClass: string;
  /** Visible mark beside the name, for states the spec marks. */
  mark?: "+" | "↗";
}

export const FEATURE_STATE_META: Record<FeatureUserState, FeatureStateMeta> = {
  supported: {
    label: "Supported",
    shortLabel: "Supported",
    icon: CircleCheck,
    rowClass: "text-foreground",
    iconClass: "text-success",
    barClass: "bg-success",
  },
  "could-add": {
    label: "Could add",
    shortLabel: "Could add",
    icon: Plus,
    rowClass: "bg-warning/15 text-foreground",
    iconClass: "text-foreground",
    barClass: "bg-warning",
    mark: "+",
  },
  "not-checked": {
    label: "Not checked yet",
    shortLabel: "Not checked",
    icon: CircleDashed,
    rowClass: "text-muted-foreground",
    iconClass: "text-muted-foreground",
    barClass: "bg-muted-foreground/30",
  },
  "needs-newer": {
    label: "Needs a newer version or client",
    shortLabel: "Needs newer",
    icon: ArrowUpRight,
    rowClass: "border border-border text-foreground",
    iconClass: "text-info",
    barClass: "bg-info",
    mark: "↗",
  },
  "check-failed": {
    label: "Check failed",
    shortLabel: "Check failed",
    icon: CircleX,
    rowClass: "bg-destructive/10 text-destructive",
    iconClass: "text-destructive",
    barClass: "bg-destructive",
  },
  "not-applicable": {
    label: "Not applicable",
    shortLabel: "Not applicable",
    icon: CircleMinus,
    rowClass: "text-muted-foreground opacity-70",
    iconClass: "text-muted-foreground",
    // Drawn only when it is the only state, so it must differ from the track.
    barClass: "bg-muted-foreground/15",
  },
};

/**
 * Why a row is "Needs a newer version or client": the connection's protocol
 * version predates the feature, or the feature waits on someone other than
 * the server (the client, including a client extension it did not
 * advertise; the host running an MCP App; or the identity provider).
 */
export type NeedsNewerCause =
  | "version"
  | "client"
  | "host"
  | "identity-provider";

export function needsNewerCause(
  feature: FeatureDefinition,
  assessment: FeatureAssessment,
): NeedsNewerCause | undefined {
  if (assessment.state !== "needs-newer") return undefined;
  if (assessment.applicability === "not-yet") return "version";
  switch (feature.owner) {
    case "client":
      return "client";
    case "host":
    case "app":
      return "host";
    case "identity-provider":
      return "identity-provider";
    default:
      return feature.assessment.requiresClientExtension ? "client" : undefined;
  }
}

const NEEDS_NEWER_LABELS: Record<
  NeedsNewerCause,
  Pick<FeatureStateMeta, "label" | "shortLabel">
> = {
  version: { label: "Needs a newer protocol version", shortLabel: "Needs newer" },
  client: { label: "Depends on the client", shortLabel: "Depends on client" },
  host: { label: "Depends on the host", shortLabel: "Depends on host" },
  "identity-provider": {
    label: "Depends on the identity provider",
    shortLabel: "Depends on identity provider",
  },
};

/**
 * A row's state text. A needs-newer row says whether it needs a newer
 * protocol version or depends on the client or host; without a known cause
 * it keeps the state's own name. Counts and the filter always use the
 * state's name.
 */
export function rowStateLabels(
  state: FeatureUserState,
  cause?: NeedsNewerCause,
): Pick<FeatureStateMeta, "label" | "shortLabel"> {
  if (state === "needs-newer" && cause) return NEEDS_NEWER_LABELS[cause];
  const { label, shortLabel } = FEATURE_STATE_META[state];
  return { label, shortLabel };
}

/** The source chip on a supported row. */
export const SOURCE_LABELS: Record<EvidenceSource, string> = {
  declared: "Declared",
  detected: "Detected",
  probed: "Probed",
  observed: "Seen in use",
  checked: "Checked",
  "oauth-flow": "OAuth",
  configured: "Set up",
};

export const MARKER_LABELS: Record<FeatureMarker, string> = {
  deprecated: "Deprecated",
  removed: "Removed",
  beta: "Beta",
  experimental: "Experimental",
  sketch: "Sketch",
  "early-access": "Early access",
};

export const OWNER_LABELS: Record<FeatureOwner, string> = {
  server: "The server",
  client: "The client",
  host: "The host application",
  app: "The MCP App",
  "authorization-server": "The authorization server",
  "identity-provider": "The identity provider",
};

export const NEXT_ACTION_LABELS: Record<FeatureNextAction, string> = {
  connect: "Connect",
  reconnect: "Reconnect",
  "run-checks": "Run checks",
  "use-in-playground": "Open Playground",
  "set-up": "Set up",
  refresh: "Refresh",
  "upgrade-version": "Change protocol version",
};

/** Count phrases in display order; zero counts are left out. */
const COUNT_PHRASES: ReadonlyArray<
  [FeatureUserState, (count: number) => string]
> = [
  ["supported", (n) => `${n} supported`],
  ["could-add", (n) => `${n} could add`],
  ["not-checked", (n) => `${n} not checked`],
  ["needs-newer", (n) => (n === 1 ? "1 needs newer" : `${n} need newer`)],
  ["check-failed", (n) => (n === 1 ? "1 check failed" : `${n} checks failed`)],
];

/**
 * "6 supported · 3 could add · 2 not checked". Not applicable is counted
 * only when nothing else is. An empty set gives "", which renders nothing.
 */
export function formatStateCounts(counts: FeatureStateCounts): string {
  const parts = COUNT_PHRASES.filter(([state]) => counts[state] > 0).map(
    ([state, phrase]) => phrase(counts[state]),
  );
  if (parts.length > 0) return parts.join(" · ");
  const notApplicable = counts["not-applicable"];
  return notApplicable > 0 ? `${notApplicable} not applicable` : "";
}

/**
 * The bar shows what the count text says: its states in its order, zeros
 * skipped, and not applicable only when nothing else is counted.
 */
export function stateBarSegments(
  counts: FeatureStateCounts,
): Array<{ state: FeatureUserState; count: number; percent: number }> {
  const counted = COUNT_PHRASES.map(([state]) => state).filter(
    (state) => counts[state] > 0,
  );
  const shown: FeatureUserState[] =
    counted.length > 0 ? counted : ["not-applicable"];
  const total = shown.reduce((sum, state) => sum + counts[state], 0);
  if (total === 0) return [];
  return shown.map((state) => ({
    state,
    count: counts[state],
    percent: (counts[state] / total) * 100,
  }));
}

/** "Nov 15, 2026, 4:20 PM" in the reader's locale. */
export function formatEvidenceTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}
