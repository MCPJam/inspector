/**
 * Clustering tuning — the client half.
 *
 * Hand-mirrored from `convex/lib/usageInsights/clusterTuning.ts` in the backend
 * repo (the two repos share no build). The DEFAULTS and RANGES must stay
 * byte-identical to that file: the ranges are re-validated server-side and a
 * drifted client would offer a slider position the mutation rejects.
 *
 * The PRESETS are client-only. The backend knows nothing about Broad or
 * Detailed — it only ever receives three numbers — which is deliberate: preset
 * naming is a UI affordance, and baking it into the wire would make renaming a
 * preset a migration.
 */

export type ClusterTuning = {
  maxClusters?: number;
  minSeparation?: number;
  linkThreshold?: number;
};

export type ResolvedClusterTuning = Required<ClusterTuning>;

/** Mirror of `CLUSTER_TUNING_DEFAULTS`. Also exactly the Balanced preset. */
export const CLUSTER_TUNING_DEFAULTS: ResolvedClusterTuning = {
  maxClusters: 8,
  minSeparation: 0.15,
  linkThreshold: 0.78,
};

/** Mirror of `CLUSTER_TUNING_RANGES`. The server re-checks every one of these. */
export const CLUSTER_TUNING_RANGES = {
  maxClusters: { min: 2, max: 24, step: 1 },
  minSeparation: { min: 0, max: 0.5, step: 0.01 },
  linkThreshold: { min: 0.5, max: 0.95, step: 0.01 },
} as const;

export type ClusterTuningKnob = keyof ResolvedClusterTuning;

/** Ordered for display: coarse-to-fine, matching how the knobs read. */
export const CLUSTER_TUNING_KNOBS: ClusterTuningKnob[] = [
  "maxClusters",
  "minSeparation",
  "linkThreshold",
];

/**
 * What each knob is, in the user's terms and then in the algorithm's.
 *
 * Both halves matter for this audience: a PM needs "how many themes", and a
 * dev debugging a weird map needs to know it is a silhouette score so they can
 * reason about why 0.3 behaved the way it did.
 */
export const CLUSTER_TUNING_KNOB_COPY: Record<
  ClusterTuningKnob,
  { label: string; hint: string }
> = {
  maxClusters: {
    label: "Max themes",
    hint: "Ceiling on themes per axis. The clustering still picks the number that fits, and never exceeds √(sessions) — so a small chatbox stays below this.",
  },
  minSeparation: {
    label: "Separation floor",
    hint: "Minimum silhouette score for a split to survive. Raise it and weakly-separated themes collapse into one; lower it and finer distinctions are kept.",
  },
  linkThreshold: {
    label: "Link distance",
    hint: "Cosine similarity two sessions need before the map draws an edge between them. Lower connects more; higher breaks the map into islands.",
  },
};

export const CLUSTER_TUNING_PRESETS = {
  broad: { maxClusters: 4, minSeparation: 0.25, linkThreshold: 0.72 },
  balanced: { ...CLUSTER_TUNING_DEFAULTS },
  detailed: { maxClusters: 16, minSeparation: 0.08, linkThreshold: 0.82 },
} as const satisfies Record<string, ResolvedClusterTuning>;

export type ClusterTuningPreset = keyof typeof CLUSTER_TUNING_PRESETS;

export const CLUSTER_TUNING_PRESET_ORDER: ClusterTuningPreset[] = [
  "broad",
  "balanced",
  "detailed",
];

export const CLUSTER_TUNING_PRESET_COPY: Record<
  ClusterTuningPreset,
  { label: string; description: string }
> = {
  broad: {
    label: "Broad",
    description: "Fewer, larger themes. Good for a first read of what sessions are about.",
  },
  balanced: {
    label: "Balanced",
    description: "The default. Themes split only where the separation is clear.",
  },
  detailed: {
    label: "Detailed",
    description: "More, smaller themes. Surfaces narrow behaviors a broad pass folds away.",
  },
};

/** Fill every knob, so a partial record can drive a slider. */
export function resolveClusterTuning(
  tuning: ClusterTuning | null | undefined,
): ResolvedClusterTuning {
  return {
    maxClusters: tuning?.maxClusters ?? CLUSTER_TUNING_DEFAULTS.maxClusters,
    minSeparation:
      tuning?.minSeparation ?? CLUSTER_TUNING_DEFAULTS.minSeparation,
    linkThreshold:
      tuning?.linkThreshold ?? CLUSTER_TUNING_DEFAULTS.linkThreshold,
  };
}

/**
 * The preset a tuning corresponds to, or null when it matches none.
 *
 * `knobs` is what the current scope actually exposes: swarm insights build no
 * topic map, so a tuning there is Broad if its two visible knobs are Broad —
 * comparing against a `linkThreshold` that scope never sends would leave the
 * preset row permanently showing nothing selected.
 */
export function presetFor(
  tuning: ClusterTuning | null | undefined,
  knobs: ClusterTuningKnob[] = CLUSTER_TUNING_KNOBS,
): ClusterTuningPreset | null {
  const resolved = resolveClusterTuning(tuning);
  return (
    CLUSTER_TUNING_PRESET_ORDER.find((preset) =>
      knobs.every(
        (knob) => CLUSTER_TUNING_PRESETS[preset][knob] === resolved[knob],
      ),
    ) ?? null
  );
}

/** Only the knobs this scope owns — never send one the mutation would reject. */
export function pickKnobs(
  tuning: ResolvedClusterTuning,
  knobs: ClusterTuningKnob[],
): ClusterTuning {
  const out: ClusterTuning = {};
  for (const knob of knobs) out[knob] = tuning[knob];
  return out;
}

/** Slider display: an integer knob shows bare, a ratio shows two decimals. */
export function formatKnobValue(
  knob: ClusterTuningKnob,
  value: number,
): string {
  return CLUSTER_TUNING_RANGES[knob].step === 1
    ? String(value)
    : value.toFixed(2);
}
