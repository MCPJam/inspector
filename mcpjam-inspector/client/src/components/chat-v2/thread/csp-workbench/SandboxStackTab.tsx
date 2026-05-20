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

interface StackRow {
  tone: "ok" | "warn" | "live" | "muted";
  label: string;
  value: React.ReactNode;
}

function markerFor(tone: StackRow["tone"]): { glyph: string; cls: string } {
  switch (tone) {
    case "ok":
      return { glyph: "→", cls: "text-emerald-600 dark:text-emerald-400" };
    case "warn":
      return { glyph: "!", cls: "text-amber-600 dark:text-amber-400" };
    case "live":
      return { glyph: "●", cls: "text-emerald-600 dark:text-emerald-400" };
    case "muted":
      return { glyph: "→", cls: "text-muted-foreground/60" };
  }
}

function StackRows({ rows }: { rows: StackRow[] }) {
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => {
        const m = markerFor(r.tone);
        return (
          <div
            key={i}
            className="grid grid-cols-[18px_1fr_auto] gap-3.5 items-center py-1 text-[11.5px]"
          >
            <span className={`font-mono text-center ${m.cls}`}>{m.glyph}</span>
            <span className="font-mono text-foreground">{r.label}</span>
            <span className="font-mono text-[11px] text-muted-foreground text-right truncate min-w-0 max-w-full">
              {r.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function lifecycleStatus(
  events: WidgetLifecycleEvent[] | undefined,
  kind: WidgetLifecycleEvent["kind"],
): WidgetLifecycleEvent | undefined {
  if (!events) return undefined;
  return [...events].reverse().find((e) => e.kind === kind);
}

function bridgeRow(events: WidgetLifecycleEvent[] | undefined): StackRow {
  const ready = lifecycleStatus(events, "bridge-connect-ready");
  const error = lifecycleStatus(events, "bridge-connect-error");
  if (error) {
    return {
      tone: "warn",
      label: "postMessage bridge",
      value: <span className="text-amber-600 dark:text-amber-400">error</span>,
    };
  }
  if (ready) {
    return {
      tone: "live",
      label: "postMessage bridge",
      value: (
        <>
          <span className="text-emerald-600 dark:text-emerald-400">live</span>
          {" · forwarding "}
          <span className="text-foreground">ui/*</span>
        </>
      ),
    };
  }
  return {
    tone: "muted",
    label: "postMessage bridge",
    value: <span className="italic text-muted-foreground">pending</span>,
  };
}

function lifecycleRow(
  events: WidgetLifecycleEvent[] | undefined,
): StackRow | null {
  if (!events || events.length === 0) return null;
  const initialized = lifecycleStatus(events, "app-initialized");
  if (initialized) {
    return {
      tone: "ok",
      label: "Lifecycle",
      value: (
        <>
          <span className="text-foreground">initialized</span>
        </>
      ),
    };
  }
  const bridgeReady = lifecycleStatus(events, "bridge-connect-ready");
  if (bridgeReady) {
    return {
      tone: "ok",
      label: "Lifecycle",
      value: <span className="text-foreground">bridge connected</span>,
    };
  }
  return {
    tone: "muted",
    label: "Lifecycle",
    value: <span className="italic text-muted-foreground">loading</span>,
  };
}

export function SandboxStackTab({
  applied,
  lifecycle,
  mounts,
  hostInfo,
  protocol,
}: SandboxStackTabProps) {
  const sandboxAttrs =
    applied?.sandboxAttrs && applied.sandboxAttrs.length > 0
      ? applied.sandboxAttrs.join(", ")
      : "allow-scripts, allow-same-origin";

  const permissionsList = applied?.permissions
    ? Object.keys(applied.permissions).map((p) =>
        p.replace(/([A-Z])/g, "-$1").toLowerCase(),
      )
    : applied?.allowFeatures
      ? Object.keys(applied.allowFeatures)
      : [];

  const outerRows: StackRow[] = [
    {
      tone: "ok",
      label: "Sandbox attributes",
      value: <span className="text-foreground">{sandboxAttrs}</span>,
    },
    {
      tone: permissionsList.length > 0 ? "ok" : "muted",
      label: "Permissions policy",
      value:
        permissionsList.length > 0 ? (
          <span className="text-foreground">{permissionsList.join(", ")}</span>
        ) : (
          <span className="italic text-muted-foreground">none granted</span>
        ),
    },
    bridgeRow(lifecycle),
  ];

  const innerRows: StackRow[] = [];
  const lc = lifecycleRow(lifecycle);
  if (lc) innerRows.push(lc);
  if (protocol) {
    innerRows.push({
      tone: "ok",
      label: "Protocol",
      value: (
        <span className="text-foreground">
          {protocol === "mcp-apps" ? "MCP Apps · SEP-1865" : "OpenAI Apps SDK"}
        </span>
      ),
    });
  }
  if (mounts && mounts.length > 0) {
    innerRows.push({
      tone: mounts.length > 1 ? "warn" : "ok",
      label: "Mount count",
      value: (
        <span
          className={
            mounts.length > 1
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground"
          }
        >
          {mounts.length} {mounts.length === 1 ? "mount" : "mounts"}
          {mounts.length > 1 ? " · check fetch-source key changes" : ""}
        </span>
      ),
    });
  }
  if (hostInfo) {
    innerRows.push({
      tone: "ok",
      label: "Host info",
      value: (
        <span className="text-foreground">
          {hostInfo.name} {hostInfo.version}
        </span>
      ),
    });
  }

  if (innerRows.length === 0) {
    innerRows.push({
      tone: "muted",
      label: "View iframe",
      value: <span className="italic text-muted-foreground">awaiting first mount</span>,
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[12.5px] font-medium">Sandbox stack</h3>
        <p className="text-[11px] text-muted-foreground">
          double iframe — outer enforces, inner runs
        </p>
      </div>

      <div className="rounded-md border border-border/40 bg-card p-4 relative">
        <div className="flex items-baseline justify-between mb-3">
          <span className="text-[12.5px] font-medium text-amber-600 dark:text-amber-400">
            Sandbox proxy iframe
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            outer · enforces CSP + permissions
          </span>
        </div>

        <StackRows rows={outerRows} />

        <div className="relative mt-4 rounded-md border border-border/40 bg-muted/15 p-4">
          <span
            aria-hidden
            className="absolute -top-2.5 left-5 block h-2.5 w-px bg-border/60"
          />
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-[12.5px] font-medium text-purple-600 dark:text-purple-400">
              View iframe
            </span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              inner · runs widget
            </span>
          </div>
          <StackRows rows={innerRows} />

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
                  span[style*="csp-live-pulse"] {
                    animation: none !important;
                  }
                }
              `}</style>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
