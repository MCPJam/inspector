import { Database } from "lucide-react";

/** SEP-2549 cache-serve provenance (§11.2) — present ONLY on an actual hit. */
export type ServedFromCache = { ageMs: number };

function formatAge(ageMs: number): string {
  if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))}ms`;
  const seconds = ageMs / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * Renders ONLY when a local cache serve actually occurred (§11.2 policy:
 * absence of a serve is semantic — never render a placeholder for "not
 * cached"). `servedFromCache` is omitted entirely by the server when there
 * was no hit, so this checks presence rather than a boolean flag.
 */
export function CacheProvenanceBadge({
  servedFromCache,
}: {
  servedFromCache?: ServedFromCache;
}) {
  if (!servedFromCache) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      title={`Served from the local client cache (SEP-2549), ${formatAge(
        servedFromCache.ageMs,
      )} old. No request was sent to the server.`}
      data-testid="cache-provenance-badge"
    >
      <Database className="h-3 w-3" aria-hidden="true" />
      served from client cache · {formatAge(servedFromCache.ageMs)}
    </span>
  );
}
