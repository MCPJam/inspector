import { useEffect, useMemo, useRef, useState } from "react";
import type { ClassifierInput, Diagnosis } from "./types";
import { extractOrigin, originAllowedByAny } from "./match-source";

interface PolicyDiffTabProps {
  input: ClassifierInput;
  diagnoses: Diagnosis[];
  /** When set, scroll to and flash the matching row in Effective + Observed. */
  jumpToHost?: string | null;
  /** Cleared after the jump animation completes. */
  onJumpHandled?: () => void;
}

type RowState = "allowed" | "blocked" | "stripped" | "cors" | "mismatch";

interface Row {
  host: string;
  directive: string;
  state: RowState;
  /** Whether to render a small "effective ≠ observed" badge */
  showMismatchTag?: boolean;
}

function expressionToHost(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed || trimmed.startsWith("'")) return null;
  if (trimmed === "*" || trimmed === "data:" || trimmed === "blob:") return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:$/.test(trimmed)) return trimmed;
  let rest = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, "");
  const slash = rest.indexOf("/");
  if (slash >= 0) rest = rest.slice(0, slash);
  return rest || null;
}

function buildRequestedRows(
  declared: ClassifierInput["widgetDeclared"] | undefined,
): Row[] {
  if (!declared) return [];
  const rows: Row[] = [];
  const pushAll = (list: string[] | undefined, directive: string) => {
    if (!list) return;
    for (const e of list) {
      const host = expressionToHost(e);
      if (host) rows.push({ host, directive, state: "allowed" });
    }
  };
  pushAll(declared.connectDomains ?? declared.connect_domains, "connect-src");
  pushAll(declared.resourceDomains ?? declared.resource_domains, "img/script/font/style-src");
  pushAll(declared.frameDomains, "frame-src");
  pushAll(declared.baseUriDomains, "base-uri");
  return rows;
}

function buildEffectiveRows(
  effective: ClassifierInput["effective"],
  mismatchHosts: Set<string>,
): Row[] {
  const rows: Row[] = [];
  const pushAll = (list: string[] | undefined, directive: string) => {
    if (!list) return;
    for (const e of list) {
      const host = expressionToHost(e);
      if (!host) continue;
      const isMismatch = mismatchHosts.has(host);
      rows.push({
        host,
        directive,
        state: isMismatch ? "mismatch" : "allowed",
        showMismatchTag: isMismatch,
      });
    }
  };
  pushAll(effective.connectDomains, "connect-src");
  pushAll(effective.resourceDomains, "img/script/font/style-src");
  pushAll(effective.frameDomains, "frame-src");
  pushAll(effective.baseUriDomains, "base-uri");
  return rows;
}

/**
 * "Stripped" rows = declared but not in effective. Renders alongside
 * the Effective column with a strike-through.
 */
function buildStrippedRows(
  declared: ClassifierInput["widgetDeclared"] | undefined,
  effective: ClassifierInput["effective"],
): Row[] {
  if (!declared) return [];
  const rows: Row[] = [];
  const push = (
    declaredList: string[] | undefined,
    effectiveList: string[] | undefined,
    directive: string,
  ) => {
    if (!declaredList) return;
    for (const e of declaredList) {
      if (!originAllowedByAny(extractOriginOrSelf(e), effectiveList)) {
        const host = expressionToHost(e);
        if (host) rows.push({ host, directive, state: "stripped" });
      }
    }
  };
  push(
    declared.connectDomains ?? declared.connect_domains,
    effective.connectDomains,
    "connect-src",
  );
  push(
    declared.resourceDomains ?? declared.resource_domains,
    effective.resourceDomains,
    "img/script/font/style-src",
  );
  push(declared.frameDomains, effective.frameDomains, "frame-src");
  push(declared.baseUriDomains, effective.baseUriDomains, "base-uri");
  return rows;
}

function extractOriginOrSelf(expr: string): string {
  // For declared *expressions* we feed back through extractOrigin where
  // possible (gives a real URL); for wildcards we pass through as-is so
  // originAllowedByAny matches by host pattern.
  if (expr.includes("*")) return `https://${expr.replace(/^https?:\/\//, "").replace(/^\*\./, "x.")}`;
  const o = extractOrigin(expr);
  return o ?? expr;
}

function buildObservedRows(diagnoses: Diagnosis[]): Row[] {
  return diagnoses.map((d) => {
    let state: RowState;
    if (d.class === "cors") state = "cors";
    else if (d.class === "runtime-mismatch") state = "mismatch";
    else state = "blocked";

    let host = d.url;
    try {
      host = new URL(d.url).host;
    } catch {
      /* leave as-is */
    }
    return {
      host,
      directive: d.directive,
      state,
      showMismatchTag: state === "mismatch",
    };
  });
}

function marker(state: RowState): { glyph: string; cls: string; label: string } {
  switch (state) {
    case "allowed":
      return { glyph: "→", cls: "text-emerald-600 dark:text-emerald-400", label: "allowed" };
    case "blocked":
      return { glyph: "×", cls: "text-destructive", label: "blocked" };
    case "stripped":
      return { glyph: "×", cls: "text-destructive", label: "stripped" };
    case "cors":
      return { glyph: "!", cls: "text-amber-600 dark:text-amber-400", label: "CORS" };
    case "mismatch":
      return { glyph: "×", cls: "text-sky-600 dark:text-sky-400", label: "blocked" };
  }
}

function PolicyColumn({
  title,
  subtitle,
  rows,
  showLabels,
  jumpHost,
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  rows: Row[];
  showLabels: boolean;
  jumpHost?: string | null;
  emptyLabel: string;
}) {
  return (
    <div className="rounded-md border border-border/40 bg-card p-3 min-w-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium">{title}</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {subtitle}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic py-2">
          {emptyLabel}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((r, i) => {
            const m = marker(r.state);
            const matches = jumpHost && hostMatches(r.host, jumpHost);
            return (
              <div
                key={`${r.host}-${r.directive}-${i}`}
                data-policy-host={r.host}
                className={`grid grid-cols-[14px_auto_1fr_auto] gap-2 items-center px-1.5 py-1 rounded text-[11.5px] font-mono ${
                  r.state === "mismatch"
                    ? "bg-sky-500/5 border border-sky-500/25 border-l-2 border-l-sky-500/60"
                    : "border border-transparent"
                } ${matches ? "ring-1 ring-sky-500 bg-sky-500/15" : ""} transition-colors motion-reduce:transition-none`}
              >
                <span className={`text-center ${m.cls}`}>{m.glyph}</span>
                {showLabels && (
                  <span className="text-[10.5px] text-muted-foreground">
                    {m.label}
                  </span>
                )}
                {!showLabels && <span aria-hidden />}
                <span
                  className={`truncate min-w-0 ${
                    r.state === "blocked" || r.state === "stripped"
                      ? "text-destructive"
                      : r.state === "cors"
                        ? "text-amber-600 dark:text-amber-400"
                        : r.state === "mismatch"
                          ? "text-sky-600 dark:text-sky-400"
                          : "text-foreground"
                  } ${r.state === "stripped" ? "line-through decoration-destructive/60" : ""}`}
                  title={r.host}
                >
                  {r.host}
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                  {r.showMismatchTag && (
                    <span className="font-mono text-[9.5px] text-sky-600 dark:text-sky-400 border border-sky-500/30 rounded px-1.5 py-0.5">
                      effective ≠ observed
                    </span>
                  )}
                  <span>{r.directive}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function hostMatches(rowHost: string, target: string): boolean {
  if (!target) return false;
  const r = rowHost.toLowerCase();
  const t = target.toLowerCase().replace(/^https?:\/\//, "");
  return r === t || r.endsWith("." + t) || ("*." + r.replace(/^\*\./, "")) === t;
}

export function PolicyDiffTab({
  input,
  diagnoses,
  jumpToHost,
  onJumpHandled,
}: PolicyDiffTabProps) {
  const [showLabels, setShowLabels] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Hosts that appear allowed by the host (effective) but observed-blocked.
  const mismatchHosts = useMemo(() => {
    const s = new Set<string>();
    for (const d of diagnoses) {
      if (d.class === "runtime-mismatch") {
        try {
          s.add(new URL(d.url).host);
        } catch {
          /* skip */
        }
      }
    }
    return s;
  }, [diagnoses]);

  const requestedRows = useMemo(
    () => buildRequestedRows(input.widgetDeclared),
    [input.widgetDeclared],
  );
  const effectiveRows = useMemo(
    () => [
      ...buildEffectiveRows(input.effective, mismatchHosts),
      ...buildStrippedRows(input.widgetDeclared, input.effective),
    ],
    [input.effective, input.widgetDeclared, mismatchHosts],
  );
  const observedRows = useMemo(() => buildObservedRows(diagnoses), [diagnoses]);

  // Scroll & flash on jumpToHost
  useEffect(() => {
    if (!jumpToHost || !containerRef.current) return;
    const target = containerRef.current.querySelector(
      `[data-policy-host="${CSS.escape(jumpToHost.replace(/^https?:\/\//, ""))}"]`,
    );
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const handle = setTimeout(() => onJumpHandled?.(), 1800);
    return () => clearTimeout(handle);
  }, [jumpToHost, onJumpHandled]);

  return (
    <div className="space-y-3" ref={containerRef}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[12.5px] font-medium">Policy divergence</h3>
          <p className="text-[11px] text-muted-foreground">
            server → host → browser
          </p>
        </div>
        <button
          type="button"
          aria-pressed={showLabels}
          onClick={() => setShowLabels((s) => !s)}
          className="h-7 px-2.5 rounded border border-border/60 bg-transparent font-mono text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted/30 data-[active=true]:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showLabels ? "Hide labels" : "Show labels"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <PolicyColumn
          title="Requested"
          subtitle="from your server"
          rows={requestedRows}
          showLabels={showLabels}
          jumpHost={jumpToHost}
          emptyLabel="No CSP declared by the widget."
        />
        <PolicyColumn
          title="Effective"
          subtitle="what host granted"
          rows={effectiveRows}
          showLabels={showLabels}
          jumpHost={jumpToHost}
          emptyLabel="No effective allowlist captured."
        />
        <PolicyColumn
          title="Observed"
          subtitle="what browser saw"
          rows={observedRows}
          showLabels={showLabels}
          jumpHost={jumpToHost}
          emptyLabel="No violations recorded."
        />
      </div>

      {mismatchHosts.size > 0 && (
        <div className="rounded-md border border-dashed border-border/60 bg-card/50 px-3 py-2 text-[11.5px] text-muted-foreground leading-relaxed">
          Rows tagged{" "}
          <span className="font-mono text-sky-600 dark:text-sky-400">
            effective ≠ observed
          </span>{" "}
          are where the host reported the origin as allowed but the browser
          still recorded a block. The cause cannot be inferred from the policy
          alone — see the runtime-mismatch cards in Findings for the
          candidate causes.
        </div>
      )}
    </div>
  );
}
