import { useRef, useState } from "react";
import { cn } from "@mcpjam/design-system/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { formatVerifiedAt } from "../verified-at";
import { getCaniuseSupportLabel } from "./caniuse-capability-catalog";
import {
  orderPublicClients,
  publicClientIdentity,
  type CapabilityCoverage,
} from "./caniuse-coverage";
import { clientLogo } from "./CaniuseSite";

export const RESULT_GROUPS = [
  {
    status: "supported",
    title: "Supported",
    tint: "bg-success/15",
    token: "--success",
  },
  {
    status: "partial",
    title: "Partial support",
    tint: "bg-warning/15",
    token: "--warning",
  },
  {
    status: "unsupported",
    title: "Not supported",
    tint: "bg-destructive/15",
    token: "--destructive",
  },
  {
    status: "unknown",
    title: "No result",
    tint: "bg-muted",
    token: "--muted",
  },
] as const;

export function groupResults(coverage: CapabilityCoverage, rows = coverage.rows) {
  return RESULT_GROUPS.map((group) => ({
    ...group,
    title:
      group.status === "supported"
        ? supportedResultLabel(coverage)
        : coverage.reporting && group.status === "unsupported"
          ? "Not reported"
          : group.title,
    clients: orderPublicClients(
      rows
        .filter(({ status }) => status === group.status)
        .map(({ subject }) => subject),
    ),
  }));
}

export function clientBadges(
  client: CapabilityCoverage["rows"][number]["subject"],
  coverage: CapabilityCoverage,
) {
  const { family, surface, mode } = publicClientIdentity(client);
  const hasVariants = coverage.rows.some(
    ({ subject }) =>
      subject.hostId !== client.hostId &&
      publicClientIdentity(subject).family === family,
  );
  return hasVariants ? [surface, mode].filter(Boolean) : [];
}

export function ClientMap({ coverage }: { coverage: CapabilityCoverage }) {
  const [openClient, setOpenClient] = useState<string | null>(null);
  const wasOpenAtTouchStart = useRef(false);
  return (
    <div className="grid gap-3">
      {groupResults(coverage)
        .filter(({ clients }) => clients.length > 0)
        .map(({ status, title, tint, clients }) => (
          <section
            key={status}
            aria-label={title}
            className={cn(
              "caniuse-map-group grid items-start gap-2.5 rounded-lg border border-border/75 p-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4",
              tint,
            )}
          >
            <h3 className="grid gap-1 text-xs font-semibold">
              <span className="text-2xl font-bold leading-none tabular-nums">
                {clients.length}
              </span>{" "}
              {title}
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {clients.map((client) => {
                const badges = clientBadges(client, coverage);
                const date = client.verifiedAt
                  ? `Last checked ${formatVerifiedAt(client.verifiedAt)}`
                  : "No verification date";
                return (
                  <li key={client.hostId}>
                    <Tooltip
                      open={openClient === client.hostId}
                      onOpenChange={(open) =>
                        setOpenClient((current) =>
                          open
                            ? client.hostId
                            : current === client.hostId
                              ? null
                              : current,
                        )
                      }
                    >
                      <TooltipTrigger asChild>
                        <div
                          role="img"
                          tabIndex={0}
                          onPointerDownCapture={(event) => {
                            if (event.pointerType === "touch") {
                              // Radix can close on pointer down and reopen on focus.
                              wasOpenAtTouchStart.current =
                                openClient === client.hostId;
                            }
                          }}
                          onClick={(event) => {
                            const pointer = event.nativeEvent;
                            if (
                              "pointerType" in pointer &&
                              pointer.pointerType === "touch"
                            ) {
                              event.preventDefault();
                              setOpenClient(
                                wasOpenAtTouchStart.current ? null : client.hostId,
                              );
                            }
                          }}
                          aria-label={`${client.hostName}. ${date}`}
                          className="flex h-14 min-w-14 flex-col items-center justify-center gap-1 rounded-md border border-border bg-card px-1 text-card-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <img
                            src={clientLogo(client)}
                            alt=""
                            className="size-6 rounded object-contain"
                            loading="lazy"
                          />
                          {badges.length > 0 && (
                            <span
                              aria-hidden="true"
                              className="flex gap-0.5 text-[9px] font-semibold leading-tight"
                            >
                              {badges.map((badge, index) => (
                                <span key={badge} className={index ? "rounded bg-accent px-1 text-accent-foreground" : "rounded bg-muted px-1 text-muted-foreground"}>
                                  {badge}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent variant="muted" className="dark caniuse-client-tooltip" sideOffset={6}>
                        <span className="block font-semibold">
                          {client.hostName}
                        </span>
                        <span className="block">{date}</span>
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}

export function capabilityResultLabel(
  status: CapabilityCoverage["rows"][number]["status"],
  fieldId: string | undefined,
  coverage: CapabilityCoverage,
) {
  if (status === "supported" && (coverage.reporting || coverage.eventsMode === "any"))
    return supportedResultLabel(coverage);
  if (coverage.reporting && status === "unsupported") return "Not reported";
  return getCaniuseSupportLabel(status, fieldId);
}

function supportedResultLabel(coverage: CapabilityCoverage) {
  if (coverage.reporting) return "Reported";
  if (coverage.eventsMode === "any") return "Supports at least one delivery mode";
  return "Supported";
}
