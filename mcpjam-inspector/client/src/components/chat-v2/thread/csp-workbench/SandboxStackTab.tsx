import { useState } from "react";
import type {
  WidgetLifecycleEvent,
  WidgetMount,
  WidgetSandboxApplied,
} from "@/stores/widget-debug-store";

interface SandboxStackTabProps {
  applied?: WidgetSandboxApplied;
  lifecycle?: WidgetLifecycleEvent[];
  mounts?: WidgetMount[];
  hostInfo?: { name: string; version: string } | null;
  protocol?: "openai-apps" | "mcp-apps";
}

/** Compact label/value chip — the workbench's atomic unit. */
function Chip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "neutral" | "warn" | "muted";
}) {
  const valueClass =
    tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "muted"
        ? "text-muted-foreground italic"
        : "text-foreground";
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] text-muted-foreground/80 mb-1">{label}</div>
      <div className={`font-mono text-[11.5px] truncate ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function lastEvent(
  events: WidgetLifecycleEvent[] | undefined,
  kind: WidgetLifecycleEvent["kind"],
): WidgetLifecycleEvent | undefined {
  if (!events) return undefined;
  return [...events].reverse().find((e) => e.kind === kind);
}

function lifecycleStatus(events: WidgetLifecycleEvent[] | undefined): {
  tone: "live" | "muted";
  text: string;
} {
  if (lastEvent(events, "app-initialized"))
    return { tone: "live", text: "initialized" };
  if (lastEvent(events, "bridge-connect-ready"))
    return { tone: "live", text: "bridge connected" };
  return { tone: "muted", text: "loading" };
}

/** Wrap a comma-joined list so the chip can show "N, M, …" + "+K more". */
function TruncatedList({ items, max = 2 }: { items: string[]; max?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0)
    return <span className="text-muted-foreground italic">none</span>;
  if (expanded || items.length <= max) {
    return <span>{items.join(", ")}</span>;
  }
  const visible = items.slice(0, max).join(", ");
  const rest = items.length - max;
  return (
    <span>
      {visible}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(true);
        }}
        className="ml-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
      >
        +{rest} more
      </button>
    </span>
  );
}

export function SandboxStackTab({
  applied,
  lifecycle,
  mounts,
  protocol,
}: SandboxStackTabProps) {
  const sandboxAttrs =
    applied?.sandboxAttrs && applied.sandboxAttrs.length > 0
      ? applied.sandboxAttrs
      : ["allow-scripts", "allow-same-origin"];

  const permissionsList = applied?.permissions
    ? Object.keys(applied.permissions).map((p) =>
        p.replace(/([A-Z])/g, "-$1").toLowerCase(),
      )
    : applied?.allowFeatures
      ? Object.keys(applied.allowFeatures)
      : [];

  const lc = lifecycleStatus(lifecycle);
  const mountCount = mounts?.length ?? 0;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/40 bg-card p-3.5">
        <div className="flex items-baseline justify-between mb-3">
          <span className="text-[12.5px] font-medium text-amber-600 dark:text-amber-400">
            Sandbox proxy iframe
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            outer
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Chip
            label="Sandbox attributes"
            value={<TruncatedList items={sandboxAttrs} max={2} />}
          />
          <Chip
            label="Permissions"
            value={
              permissionsList.length === 0 ? (
                <span className="text-muted-foreground italic">none</span>
              ) : (
                <TruncatedList items={permissionsList} max={3} />
              )
            }
            tone={permissionsList.length === 0 ? "muted" : "neutral"}
          />
        </div>

        <div className="mt-3.5 rounded-md border border-border/40 bg-muted/15 p-3">
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-[12.5px] font-medium text-purple-600 dark:text-purple-400">
              View iframe
            </span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              inner
            </span>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Chip
              label="Lifecycle"
              value={
                <span
                  className={
                    lc.tone === "muted"
                      ? "text-muted-foreground italic"
                      : "text-foreground"
                  }
                >
                  {lc.text}
                </span>
              }
              tone={lc.tone === "muted" ? "muted" : "neutral"}
            />
            {mountCount > 1 && (
              <Chip
                label="Mount count"
                value={
                  <span className="text-amber-600 dark:text-amber-400">
                    {mountCount} mounts · check fetch-source key
                  </span>
                }
                tone="warn"
              />
            )}
          </div>

          {protocol === "openai-apps" && (
            <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-background border border-border/40 font-mono text-[11px]">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 motion-reduce:opacity-100"
                style={{
                  boxShadow: "0 0 4px rgb(16 185 129 / 0.7)",
                  animation: "csp-live-pulse 2s ease-in-out infinite",
                }}
                aria-hidden
              />
              <span>window.openai</span>
              <style>{`
                @keyframes csp-live-pulse {
                  0%,100% { opacity: 1; }
                  50% { opacity: 0.4; }
                }
                @media (prefers-reduced-motion: reduce) {
                  span[style*="csp-live-pulse"] { animation: none !important; }
                }
              `}</style>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
