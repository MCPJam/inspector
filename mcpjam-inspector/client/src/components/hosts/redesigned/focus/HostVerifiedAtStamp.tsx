import { Check, TriangleAlert } from "lucide-react";
import { getCatalogHost } from "@mcpjam/sdk/host-compat";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { MCPJAM_WEB_DEPLOYED_AT } from "@/generated/mcpjam-web-deployed-at";
import {
  formatVerifiedAt,
  isVerifiedAtStale,
  resolveVerifiedAt,
  STALE_VERIFIED_AT_LABEL,
} from "../../verified-at";
import { cn } from "@/lib/utils";

interface HostVerifiedAtStampProps {
  /** Catalog host id the client is built from (`draft.hostStyle`). */
  hostStyle: string;
  className?: string;
}

const stampPillClass =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] font-medium leading-tight";

/**
 * When we last checked this client profile against the real app, shown beside
 * "Update to latest" — the date is what makes that button worth pressing.
 *
 * Reads as a pill so the header carries a verdict, not a footnote: green while
 * the check still holds, amber once it has aged out. Same date, same 30-day
 * staleness wording as the Host Compare matrix (both read `../../verified-at`).
 * Renders nothing for a client whose catalog row we have never verified,
 * rather than printing an empty placeholder.
 */
export function HostVerifiedAtStamp({
  hostStyle,
  className,
}: HostVerifiedAtStampProps) {
  const catalogState = useHostCatalog();
  // Whichever catalog we ended up with, live or bundled fallback — Host
  // Compare reads it the same way, and a date that disagrees with the table
  // is worse than a date from the fallback. `catalog` is null only while
  // loading or after a hard failure.
  const catalogHost = catalogState.catalog
    ? getCatalogHost(catalogState.catalog, hostStyle)
    : undefined;
  // No catalog row (still loading, or a style we don't track) means no claim
  // to make — including for MCPJam, whose deploy stamp would otherwise print
  // a date for a profile we can't read.
  if (!catalogHost) return null;
  const verifiedAt = resolveVerifiedAt(
    hostStyle,
    catalogHost.verifiedAt,
    MCPJAM_WEB_DEPLOYED_AT,
  );
  if (verifiedAt === undefined || !Number.isFinite(verifiedAt)) return null;

  const formatted = formatVerifiedAt(verifiedAt);

  if (isVerifiedAtStale(verifiedAt)) {
    return (
      <span
        data-testid="host-verified-at-stamp"
        title={`Last checked ${formatted}`}
        className={cn(
          stampPillClass,
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
          className,
        )}
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {STALE_VERIFIED_AT_LABEL}
      </span>
    );
  }

  return (
    <span
      data-testid="host-verified-at-stamp"
      title={`Last checked ${formatted}`}
      className={cn(
        stampPillClass,
        "tabular-nums border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        className,
      )}
    >
      <Check className="size-3.5 shrink-0" aria-hidden />
      Verified {formatted}
    </span>
  );
}
