import { useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import type { Diagnosis } from "./types";
import { summarize } from "./classify";
import { BlockedRequestCard } from "./BlockedRequestCard";

interface FindingsTabProps {
  diagnoses: Diagnosis[];
  onViewPolicyDiff: (host: string) => void;
}

interface MeterPart {
  count: number;
  label: string;
  cls: string;
}

export function FindingsTab({ diagnoses, onViewPolicyDiff }: FindingsTabProps) {
  const summary = useMemo(() => summarize(diagnoses), [diagnoses]);

  if (diagnoses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
        <CheckCircle2 className="size-8 text-emerald-500/70" />
        <div className="text-sm font-medium">No CSP violations recorded.</div>
        <div className="text-[11.5px] text-muted-foreground max-w-md">
          The widget loaded without tripping any{" "}
          <span className="font-mono">securitypolicyviolation</span> events.
          Check Policy Diff to inspect the declared / effective allowlists.
        </div>
      </div>
    );
  }

  const parts: MeterPart[] = [
    { count: summary.csp, label: "CSP", cls: "text-destructive" },
    {
      count: summary.cors,
      label: "CORS",
      cls: "text-amber-600 dark:text-amber-400",
    },
    {
      count: summary.hostStripped,
      label: "host-stripped",
      cls: "text-purple-600 dark:text-purple-400",
    },
    {
      count: summary.runtimeMismatch,
      label: "mismatch",
      cls: "text-sky-600 dark:text-sky-400",
    },
  ].filter((p) => p.count > 0);

  const fixesPart =
    summary.fixes > 0
      ? `${summary.fixes} ${summary.fixes === 1 ? "fix" : "fixes"}`
      : null;
  const declPart =
    summary.declarations > 0
      ? `${summary.declarations} ${summary.declarations === 1 ? "declaration" : "declarations"}`
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3 px-1">
        <h3 className="text-[12.5px] font-medium">Blocked requests</h3>
        <div className="flex items-baseline gap-2 font-mono text-[11px]">
          {parts.map((p, i) => (
            <span key={p.label} className="flex items-baseline gap-1">
              {i > 0 && <span className="text-muted-foreground/40">·</span>}
              <span className={`font-semibold ${p.cls}`}>{p.count}</span>
              <span className="text-muted-foreground">{p.label}</span>
            </span>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground font-mono">
          {[fixesPart, declPart].filter(Boolean).join(" · ")}
        </span>
      </div>

      <div className="space-y-2">
        {diagnoses.map((d, i) => (
          <BlockedRequestCard
            key={d.id}
            diagnosis={d}
            index={i}
            defaultOpen={i === 0}
            onViewPolicyDiff={onViewPolicyDiff}
          />
        ))}
      </div>
    </div>
  );
}
