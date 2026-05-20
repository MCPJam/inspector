import { useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import type { Diagnosis } from "./types";
import { summarize } from "./classify";
import { BlockedRequestCard } from "./BlockedRequestCard";

interface FindingsTabProps {
  diagnoses: Diagnosis[];
  onViewPolicyDiff: (host: string) => void;
}

interface SummaryItem {
  count: number;
  label: string;
  tone: "csp" | "cors" | "host-stripped" | "runtime-mismatch" | "fixes" | "declaration";
  show: boolean;
}

function summaryClasses(tone: SummaryItem["tone"]): string {
  switch (tone) {
    case "csp":
      return "text-destructive";
    case "cors":
      return "text-amber-600 dark:text-amber-400";
    case "host-stripped":
      return "text-purple-600 dark:text-purple-400";
    case "runtime-mismatch":
      return "text-sky-600 dark:text-sky-400";
    case "fixes":
      return "text-emerald-600 dark:text-emerald-400";
    case "declaration":
      return "text-foreground";
  }
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
          The Policy Diff tab still shows what the host applied if you want to
          inspect the declared / effective allowlists.
        </div>
      </div>
    );
  }

  const partition: SummaryItem[] = [
    { count: summary.csp,             label: "CSP",              tone: "csp",              show: summary.csp > 0 },
    { count: summary.cors,            label: "CORS",             tone: "cors",             show: summary.cors > 0 },
    { count: summary.hostStripped,    label: "Host-stripped",    tone: "host-stripped",    show: summary.hostStripped > 0 },
    { count: summary.runtimeMismatch, label: "Runtime-mismatch", tone: "runtime-mismatch", show: summary.runtimeMismatch > 0 },
  ];
  const ctas: SummaryItem[] = [
    { count: summary.fixes,        label: summary.fixes === 1 ? "fix" : "fixes", tone: "fixes", show: summary.fixes > 0 },
    { count: summary.declarations, label: summary.declarations === 1 ? "declaration" : "declarations", tone: "declaration", show: summary.declarations > 0 },
  ];

  const subText = [
    `${summary.total} ${summary.total === 1 ? "finding" : "findings"}`,
    summary.fixes > 0 ? `${summary.fixes} ${summary.fixes === 1 ? "fix" : "fixes"}` : null,
    summary.declarations > 0
      ? `${summary.declarations} ${summary.declarations === 1 ? "declaration" : "declarations"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border/40 bg-card px-3 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {partition.filter((p) => p.show).map((p) => (
          <div key={p.label} className="flex items-baseline gap-1.5">
            <span className={`font-mono text-[15px] font-semibold ${summaryClasses(p.tone)}`}>
              {p.count}
            </span>
            <span className="text-[11.5px] text-muted-foreground">{p.label}</span>
          </div>
        ))}
        <span className="flex-1" />
        {ctas.filter((c) => c.show).map((c, idx, arr) => (
          <div key={c.label} className="flex items-baseline gap-1.5">
            <span className={`font-mono text-[15px] font-semibold ${summaryClasses(c.tone)}`}>
              {c.count}
            </span>
            <span className="text-[11.5px] text-muted-foreground">{c.label}</span>
            {idx < arr.length - 1 && (
              <span className="text-[11px] text-muted-foreground/60 ml-2">·</span>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-baseline gap-3 px-1">
        <h3 className="text-[12.5px] font-medium">Blocked requests</h3>
        <span className="inline-flex items-center font-mono text-[10.5px] text-muted-foreground border border-border/40 rounded-full px-2 py-0.5">
          {summary.total}
        </span>
        <span className="ml-auto text-[11.5px] text-muted-foreground font-mono">
          {subText}
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
