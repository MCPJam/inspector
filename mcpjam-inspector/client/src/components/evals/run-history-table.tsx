import type { ComponentProps, ReactNode } from "react";
import { Table } from "@mcpjam/design-system/table";
import { cn } from "@/lib/utils";

/** Shared Paper run-table layout for project runs and suite history. */
export const runHistorySurfaceClass =
  "shrink-0 overflow-hidden rounded-xl border border-border bg-card";
export const runHistoryToolbarClass =
  "flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/55 px-4 py-3";
export const runHistoryFilterClass =
  "h-7 max-w-52 gap-1 rounded-full border-border bg-card px-2.5 text-[11px] font-medium shadow-none";
export const runHistoryFooterClass =
  "flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-muted/30 px-[18px] py-2.5 text-[11px] text-muted-foreground";

export function RunHistoryTable({
  className,
  ...props
}: ComponentProps<typeof Table>) {
  return (
    <Table
      {...props}
      className={cn(
        "min-w-[800px] text-xs [&_thead]:bg-muted/55 [&_th]:h-9 [&_th]:px-[18px] [&_th]:text-[10px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.04em] [&_th]:text-muted-foreground [&_td]:px-[18px] [&_td]:py-2.5 [&_tr]:border-border/50 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/35 [&_tbody_tr:focus-visible]:bg-muted/35 [&_tbody_tr:focus-visible]:outline-ring",
        className,
      )}
    />
  );
}

export function RunHistorySummary({
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex flex-wrap items-start gap-x-8 gap-y-3 px-[18px] py-3",
        props.className,
      )}
    >
      {children}
    </div>
  );
}

export function RunHistoryStat({
  value,
  label,
  detail,
  ...props
}: {
  value: ReactNode;
  label: string;
  detail?: ReactNode;
} & ComponentProps<"div">) {
  return (
    <div {...props} className={cn("min-w-0", props.className)}>
      <div className="text-base font-semibold leading-5 tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
      {detail && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}
