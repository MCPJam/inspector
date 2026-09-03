import { TriangleAlert } from "lucide-react";
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

/**
 * When we last checked this client profile against the real app, shown beside
 * "Update to latest" — the date is what makes that button worth pressing.
 *
 * Same date, same 30-day staleness wording as the Host Compare matrix (both
 * read `../../verified-at`). Renders nothing for a client whose catalog row we
 * have never verified, rather than printing an empty placeholder.
 */
export function HostVerifiedAtStamp({
  hostStyle,
  className,
}: HostVerifiedAtStampProps) {
  const catalogState = useHostCatalog();
  const catalogHost =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, hostStyle)
      : undefined;
  // No catalog row (still loading, degraded, or a style we don't track) means
  // no claim to make — including for MCPJam, whose deploy stamp would
  // otherwise print a date for a profile we can't read.
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
          "inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] leading-tight text-muted-foreground",
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
      className={cn(
        "whitespace-nowrap text-[11.5px] leading-tight tabular-nums text-muted-foreground",
        className,
      )}
    >
      Last checked {formatted}
    </span>
  );
}
