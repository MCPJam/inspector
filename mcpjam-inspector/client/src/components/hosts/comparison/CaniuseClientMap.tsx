import { useState } from "react";
import { Check, CircleHelp, Minus, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { formatVerifiedAt } from "../verified-at";
import { getCaniuseSupportLabel } from "./caniuse-capability-catalog";
import {
  orderPublicClients,
  publicClientIdentity,
  type CapabilityCoverage,
} from "./caniuse-coverage";
import { clientLogo } from "./CaniuseSite";
import { FieldCell } from "./host-config-comparison-matrix";
import { SupportChip } from "./support-chip";

export const RESULT_GROUPS = [
  {
    status: "supported",
    title: "Supported",
    Icon: Check,
    tint: "bg-success/15",
    token: "--success",
  },
  {
    status: "partial",
    title: "Partial support",
    Icon: Minus,
    tint: "bg-warning/15",
    token: "--warning",
  },
  {
    status: "unsupported",
    title: "Not supported",
    Icon: X,
    tint: "bg-destructive/15",
    token: "--destructive",
  },
  {
    status: "unknown",
    title: "No result",
    Icon: CircleHelp,
    tint: "bg-muted",
    token: "--muted",
  },
] as const;

export function groupResults(coverage: CapabilityCoverage) {
  return RESULT_GROUPS.map((group) => ({
    ...group,
    title:
      coverage.reporting && group.status === "supported"
        ? "Reported"
        : coverage.reporting && group.status === "unsupported"
          ? "Not reported"
        : group.title,
    clients: orderPublicClients(
      coverage.rows
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
  return (
    <div className="grid gap-3">
      {groupResults(coverage)
        .filter(({ clients }) => clients.length > 0)
        .map(({ status, title, Icon, tint, clients }) => (
          <section
            key={status}
            aria-label={title}
            className="rounded-xl border border-border bg-card px-4 py-4 text-card-foreground sm:px-6 sm:py-5"
          >
            <h2
              className={`mb-4 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tint}`}
            >
              <Icon className="size-3.5" /> {title}{" "}
              <span className="tabular-nums text-muted-foreground">
                {clients.length}
              </span>
            </h2>
            <ul className="flex flex-wrap gap-2 sm:gap-2.5">
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
                          open ? client.hostId : current === client.hostId ? null : current,
                        )
                      }
                    >
                      <TooltipTrigger asChild>
                        <div
                          role="img"
                          tabIndex={0}
                          onClick={(event) => {
                            const pointer = event.nativeEvent;
                            if ("pointerType" in pointer && pointer.pointerType === "touch") {
                              event.preventDefault();
                              setOpenClient((current) =>
                                current === client.hostId ? null : client.hostId,
                              );
                            }
                          }}
                          aria-label={`${client.hostName}. ${date}`}
                          className="flex h-[72px] w-[76px] flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-background py-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:h-20 sm:w-[90px]"
                        >
                          <img
                            src={clientLogo(client)}
                            alt=""
                            className="size-8 rounded object-contain sm:size-9"
                            loading="lazy"
                          />
                          {badges.length > 0 && (
                            <span
                              aria-hidden="true"
                              className="max-w-full truncate rounded bg-muted px-1 text-[9px] font-semibold text-muted-foreground"
                            >
                              {badges.join(" · ")}
                            </span>
                          )}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent variant="muted" className="dark">
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

export function CapabilityReference({
  coverage,
  field,
  slice,
}: {
  coverage: CapabilityCoverage;
  field: HostConfigFieldDef;
  slice: string;
}) {
  return (
    <div className="overflow-auto rounded-xl border border-border bg-card text-card-foreground">
      <table className="w-full min-w-[440px] text-left text-sm">
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3">
              Client
            </th>
            <th scope="col" className="px-4 py-3">
              Status
            </th>
            <th scope="col" className="px-4 py-3">
              Last checked
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {coverage.rows.map(({ subject, status }) => {
            const value = field.read(subject.config);
            const displayValue =
              (!slice || slice === "any") &&
              Array.isArray(value) &&
              value.every((item) => typeof item === "string")
                ? value.join(", ")
                : "";
            const label = capabilityResultLabel(
              status,
              field.id,
              coverage.reporting,
            );
            return (
              <tr key={subject.hostId}>
                <th scope="row" className="px-4 py-2.5 font-medium">
                  <span className="flex items-center gap-2">
                    <img
                      alt=""
                      src={clientLogo(subject)}
                      className="size-5 shrink-0 rounded object-contain"
                    />
                    {subject.hostName}
                  </span>
                </th>
                <td className="px-4 py-2.5">
                  <SupportChip level={status} label={label} />
                  {coverage.reporting && status === "supported" && (
                    <div className="mt-1 max-w-80">
                      <FieldCell field={field} subject={subject} mobileOptimized />
                    </div>
                  )}
                  {displayValue && (
                    <span className="mt-1 block max-w-80 break-words text-xs text-muted-foreground">
                      {displayValue}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                  {formatVerifiedAt(subject.verifiedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function capabilityResultLabel(
  status: CapabilityCoverage["rows"][number]["status"],
  fieldId: string | undefined,
  reporting: boolean,
) {
  if (reporting && status === "supported") return "Reported";
  if (reporting && status === "unsupported") return "Not reported";
  return getCaniuseSupportLabel(status, fieldId);
}
