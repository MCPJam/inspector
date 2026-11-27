import { Fragment, type FocusEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { groupHostConfigFields, HostComparisonSubject, HostConfigFieldDef } from "@/lib/host-config-field-schema";
import { TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mcpjam/design-system/tooltip";
import { formatVerifiedAt, isVerifiedAtStale, STALE_VERIFIED_AT_LABEL } from "../verified-at";

export function revealFocusedCell({ currentTarget: scrollBox, target }: FocusEvent<HTMLDivElement>) {
  if (!target.matches(":focus-visible")) return;
  const cell = target.closest<HTMLTableCellElement>("td, th");
  const field = cell?.parentElement?.firstElementChild;
  if (!cell || cell === field || !field) return;

  // A browser can consider the focused element visible behind the sticky cell.
  const left = field.getBoundingClientRect().right + 3;
  const right = scrollBox.getBoundingClientRect().left + scrollBox.clientWidth - 3;
  const bounds = target.getBoundingClientRect();
  if (bounds.left < left) scrollBox.scrollLeft += Math.floor(bounds.left - left);
  else if (bounds.right > right) scrollBox.scrollLeft += Math.ceil(bounds.right - right);
}

export type CompactMatrixCell = (props: {
  field: HostConfigFieldDef;
  subject: HostComparisonSubject;
  mobileOptimized: boolean;
  compact: boolean;
  stacked?: boolean;
}) => ReactNode;

export type MatrixSummaryColumn = {
  label: string;
  render: (field: HostConfigFieldDef) => ReactNode;
  renderSlices?: (field: HostConfigFieldDef) => ReactNode;
  renderFieldLabel?: (field: HostConfigFieldDef) => ReactNode;
};

interface CompactRowProps {
  renderCell: CompactMatrixCell;
  subjects: readonly HostComparisonSubject[];
  summaryColumn: MatrixSummaryColumn;
  showDescriptions: boolean;
  mobileOptimized: boolean;
}

export function CompactMatrixRows({
  groups, visibleFieldIds, ...rowProps
}: CompactRowProps & {
  groups: ReturnType<typeof groupHostConfigFields>;
  visibleFieldIds: ReadonlySet<string>;
}) {
  return groups.flatMap(({ section, subsections }) =>
    subsections.map(({ label, fields }) => {
      const visibleFields = fields.filter(({ id }) => visibleFieldIds.has(id));
      if (visibleFields.length === 0) return null;
      return (
        <Fragment key={`${section.id}-${label}`}>
          <tr className="border-b border-border bg-muted">
            <th colSpan={rowProps.subjects.length + 2} className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground sm:px-5">
              {section.label === label ? label : `${section.label} / ${label}`}
            </th>
          </tr>
          {visibleFields.map((field) => (
            <CompactFieldRow key={field.id} field={field} {...rowProps} />
          ))}
        </Fragment>
      );
    }),
  );
}

function CompactFieldRow({
  field,
  renderCell: Cell,
  subjects,
  summaryColumn,
  showDescriptions,
  mobileOptimized,
}: CompactRowProps & { field: HostConfigFieldDef }) {
  const slices = summaryColumn.renderSlices?.(field);
  return (
    <tr className="border-b border-border last:border-b-0">
      <th scope="row" className="sticky left-0 z-10 bg-card font-normal px-3 py-2.5 text-left after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border after:content-[''] sm:px-5">
        <span className="text-[13px] font-medium leading-tight text-foreground [overflow-wrap:anywhere]">
          {summaryColumn.renderFieldLabel?.(field) ?? field.label}
        </span>
        {field.description && showDescriptions && (
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {field.description}
          </div>
        )}
      </th>
      <td
        className={cn(
          "border-l border-border px-2 py-2.5 align-top sm:px-3",
          // Keep focused adoption links clear of the sticky Field column.
          mobileOptimized && "[&_a]:scroll-ml-[var(--matrix-field-width)]",
        )}
      >
        <div className="flex flex-col gap-1 text-left tabular-nums">
          {summaryColumn.render(field)}
          {slices && <div role="group" aria-label="Adoption by mode" className="mt-1 grid grid-cols-3 gap-x-1.5 gap-y-2 border-t border-border pt-2">{slices}</div>}
        </div>
      </td>
      {subjects.map((s) => (
        <td
          key={s.hostId}
          className="border-l border-border px-3 py-2.5 text-center align-top sm:px-4"
        >
          <Cell
            field={field}
            subject={s}
            mobileOptimized={mobileOptimized}
            compact
          />
        </td>
      ))}
    </tr>
  );
}

export function CompactClientName({ subject, href, className }: {
  subject: HostComparisonSubject;
  href: string | null;
  className: string;
}) {
  if (!href) return <span className={cn(className, "break-words")}>{subject.hostName}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          data-testid={`host-compare-verify-${subject.hostId}`}
          className={cn(className, "scroll-ml-[var(--matrix-field-width)] rounded-sm break-words underline decoration-border underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring")}
        >
          {subject.hostName}
        </a>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} variant="muted" className="dark">
        Verify against your server
      </TooltipContent>
    </Tooltip>
  );
}

export function CompactVerifiedDate({ subject, className }: { subject: HostComparisonSubject; className?: string }) {
  const date = formatVerifiedAt(subject.verifiedAt);
  const stale = isVerifiedAtStale(subject.verifiedAt);
  if (date === "—") return null;
  return (
    <time
      dateTime={date}
      title={stale ? STALE_VERIFIED_AT_LABEL : undefined}
      className={cn("mt-1.5 inline-flex items-center gap-1 text-[10px] leading-tight font-normal text-muted-foreground", className)}
    >
      {stale && <TriangleAlert className="size-3 shrink-0" aria-hidden />}
      <span>
        Verified on <span className="whitespace-nowrap">{date}</span>
      </span>
    </time>
  );
}
