import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ClassifierInput, Diagnosis } from "./types";
import { extractOrigin, originAllowedByAny } from "./match-source";

interface PolicyDiffTabProps {
  input: ClassifierInput;
  diagnoses: Diagnosis[];
  /** When set, expand the relevant columns and scroll to the matching row. */
  jumpToHost?: string | null;
  /** Cleared after the jump animation completes. */
  onJumpHandled?: () => void;
}

type RowState = "allowed" | "blocked" | "stripped" | "cors" | "mismatch";

interface Row {
  host: string;
  directive: string;
  state: RowState;
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
  if (expr.includes("*"))
    return `https://${expr.replace(/^https?:\/\//, "").replace(/^\*\./, "x.")}`;
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

function marker(state: RowState): { glyph: string; cls: string } {
  switch (state) {
    case "allowed":
      return { glyph: "→", cls: "text-emerald-600 dark:text-emerald-400" };
    case "blocked":
      return { glyph: "×", cls: "text-destructive" };
    case "stripped":
      return { glyph: "×", cls: "text-destructive" };
    case "cors":
      return { glyph: "!", cls: "text-amber-600 dark:text-amber-400" };
    case "mismatch":
      return { glyph: "×", cls: "text-sky-600 dark:text-sky-400" };
  }
}

function summarize(rows: Row[]): { directives: number; sources: number } {
  const directives = new Set<string>();
  for (const r of rows) directives.add(r.directive);
  return { directives: directives.size, sources: rows.length };
}

function summaryTone(rows: Row[]): "ok" | "warn" | "muted" {
  if (rows.length === 0) return "muted";
  if (rows.some((r) => r.state === "blocked" || r.state === "stripped"))
    return "warn";
  if (rows.some((r) => r.state === "cors" || r.state === "mismatch"))
    return "warn";
  return "ok";
}

function PolicyColumn({
  title,
  subtitle,
  rows,
  emptyLabel,
  jumpHost,
  forceOpen,
}: {
  title: string;
  subtitle: string;
  rows: Row[];
  emptyLabel: string;
  jumpHost?: string | null;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarize(rows);
  const tone = summaryTone(rows);
  const isOpen = open || Boolean(forceOpen);

  const summaryText =
    rows.length === 0
      ? emptyLabel
      : tone === "warn" && (title === "Observed")
        ? `${rows.length} ${rows.length === 1 ? "block" : "blocks"}`
        : `${summary.directives} ${summary.directives === 1 ? "directive" : "directives"} · ${summary.sources} ${summary.sources === 1 ? "source" : "sources"}`;

  return (
    <div className="rounded-md border border-border/40 bg-card min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={isOpen}
        className="w-full text-left px-3 py-2.5 flex items-start justify-between gap-2 hover:bg-muted/30 transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-medium">{title}</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {subtitle}
            </span>
          </div>
          <div
            className={`mt-1 font-mono text-[11.5px] truncate ${
              rows.length === 0
                ? "text-muted-foreground italic"
                : tone === "warn"
                  ? title === "Observed"
                    ? "text-destructive"
                    : "text-amber-600 dark:text-amber-400"
                  : "text-foreground"
            }`}
          >
            {summaryText}
          </div>
        </div>
        <ChevronDown
          aria-hidden
          className={`size-3.5 text-muted-foreground shrink-0 mt-1 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && rows.length > 0 && (
        <div className="border-t border-border/40 px-3 py-2 flex flex-col gap-1">
          {rows.map((r, i) => {
            const m = marker(r.state);
            const matches = jumpHost && hostMatches(r.host, jumpHost);
            return (
              <div
                key={`${r.host}-${r.directive}-${i}`}
                data-policy-host={r.host}
                className={`grid grid-cols-[14px_1fr_auto] gap-2 items-center px-1.5 py-1 rounded text-[11.5px] font-mono ${
                  r.state === "mismatch"
                    ? "bg-sky-500/5 border border-sky-500/25 border-l-2 border-l-sky-500/60"
                    : "border border-transparent"
                } ${matches ? "ring-1 ring-sky-500 bg-sky-500/15" : ""} transition-colors motion-reduce:transition-none`}
              >
                <span className={`text-center ${m.cls}`}>{m.glyph}</span>
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
                <span className="text-[10px] text-muted-foreground/70">
                  {r.directive}
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
  const containerRef = useRef<HTMLDivElement | null>(null);

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
      <div>
        <h3 className="text-[12.5px] font-medium">Policy divergence</h3>
        <p className="text-[11px] text-muted-foreground">
          server → host → browser
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        <PolicyColumn
          title="Requested"
          subtitle="from server"
          rows={requestedRows}
          emptyLabel="No CSP declared"
          jumpHost={jumpToHost}
          forceOpen={Boolean(jumpToHost)}
        />
        <PolicyColumn
          title="Effective"
          subtitle="host granted"
          rows={effectiveRows}
          emptyLabel="No allowlist captured"
          jumpHost={jumpToHost}
          forceOpen={Boolean(jumpToHost)}
        />
        <PolicyColumn
          title="Observed"
          subtitle="browser saw"
          rows={observedRows}
          emptyLabel="No violations"
          jumpHost={jumpToHost}
          forceOpen={Boolean(jumpToHost)}
        />
      </div>

      {mismatchHosts.size > 0 && (
        <div className="rounded-md border border-dashed border-border/60 bg-card/50 px-3 py-2 text-[11.5px] text-muted-foreground leading-relaxed">
          Rows tagged{" "}
          <span className="font-mono text-sky-600 dark:text-sky-400">
            effective ≠ observed
          </span>{" "}
          are where the host reported the origin as allowed but the browser
          still blocked it. See Findings for the candidate causes.
        </div>
      )}
    </div>
  );
}
