// Preview-only sample data for reviewing free-grant states on Jamroom.
// Lives on a preview branch; not for merge.
import type { EvalIterationQuota } from "@/hooks/use-eval-iteration-quota";

const STORAGE_KEY = "mcpjam:credit-preview-sample";

type Grants = { swarm: number | null; evals: number | null };

const SAMPLES: Record<string, Grants> = {
  swarm: { swarm: 320, evals: null },
  evals: { swarm: null, evals: 420 },
  both: { swarm: 320, evals: 420 },
  low: { swarm: 35, evals: 20 },
  "used-up": { swarm: 0, evals: 0 },
};

function readSample(): Grants | null {
  const fromUrl = new URLSearchParams(window.location.search).get(
    "credit_sample",
  );
  if (fromUrl === "off") localStorage.removeItem(STORAGE_KEY);
  else if (fromUrl && SAMPLES[fromUrl]) localStorage.setItem(STORAGE_KEY, fromUrl);
  return SAMPLES[localStorage.getItem(STORAGE_KEY) ?? ""] ?? null;
}

export function withCreditPreviewSample(
  swarm: { remaining: number; granted: number } | null,
  quota: EvalIterationQuota | undefined,
) {
  const sample = readSample();
  if (!sample) return { swarm, quota };
  return {
    swarm:
      sample.swarm === null ? null : { remaining: sample.swarm, granted: 500 },
    quota: {
      used: 0,
      allowed: null,
      resetsAt: 0,
      windowKind: "day" as const,
      ...quota,
      starterRemaining: sample.evals,
    },
  };
}
