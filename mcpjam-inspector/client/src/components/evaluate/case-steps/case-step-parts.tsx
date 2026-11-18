/** The steps editor's pieces: rail, section, assertion row, chips, role, ⋯ menu. */
import type { ReactNode } from "react";
import { Lock, MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import { RoleSegmentGroup } from "@/components/evals/scorer-role-control";
import {
  roleOfPredicate,
  withPredicateRole,
} from "@/components/evals/suite-scorer-table-model";
import type { Predicate } from "@/shared/eval-matching";
import { rolesForPredicateKind } from "@/shared/predicate-kinds";

export const ADD_SMALL =
  "h-8 border-dashed bg-transparent text-xs font-medium text-muted-foreground shadow-none hover:text-foreground";
export const ADD_WIDE =
  "h-10 w-full border-dashed text-[13px] font-medium text-foreground";

const CHIP_TONE = {
  case: "bg-primary/10 text-primary",
  suite: "bg-muted text-muted-foreground",
  outline: "border border-border text-muted-foreground",
} as const;

export function StepChip({
  tone,
  title,
  children,
}: {
  tone: keyof typeof CHIP_TONE;
  title: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-medium",
        CHIP_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Where a row is set: suite settings or this case. */
export const ScopeChip = ({ suite }: { suite?: boolean }) =>
  suite ? (
    <StepChip tone="suite" title="Shared default, set in suite settings">
      Suite
    </StepChip>
  ) : (
    <StepChip tone="case" title="Set on this case only">
      This case
    </StepChip>
  );

export const NonBlockingChip = () => (
  <StepChip
    tone="outline"
    title="Shown on the result. Never fails the iteration."
  >
    Advisory
  </StepChip>
);

export const InheritedLock = () => (
  <span
    title="Inherited from the suite"
    className="flex size-6 items-center justify-center text-muted-foreground"
  >
    <Lock className="size-3.5" aria-label="Inherited from the suite" />
  </span>
);

export type StepMenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

export function StepMenu({
  label,
  items,
}: {
  label: string;
  items: StepMenuItem[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 p-0 text-muted-foreground"
          aria-label={`Options for ${label}`}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            disabled={item.disabled}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "If this misses": the shared Required / Advisory switch. */
export function RoleControl({
  predicate,
  onChange,
  readOnly,
}: {
  predicate: Predicate;
  onChange: (next: Predicate) => void;
  readOnly: boolean;
}) {
  const allowed = rolesForPredicateKind(predicate.type);
  const warnOnly = !allowed.includes("required");
  return (
    <div
      className="space-y-1"
      title={warnOnly ? "This assertion can only warn." : undefined}
    >
      <Label className="text-xs font-medium text-muted-foreground">
        If this misses
      </Label>
      <RoleSegmentGroup
        value={roleOfPredicate(predicate)}
        disabledRoles={
          readOnly ? ["required", "advisory"] : warnOnly ? ["required"] : []
        }
        ariaLabel="If this assertion misses"
        onChange={(role) => onChange(withPredicateRole(predicate, role))}
      />
    </div>
  );
}

/** Numbered marker and the line down to the next section. */
export function StepRail({
  marker,
  dashed = false,
  last = false,
  children,
}: {
  marker?: ReactNode;
  dashed?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:gap-x-4">
      <div className="relative flex justify-center">
        {marker != null ? (
          <span
            className={cn(
              "relative z-10 flex size-9 items-center justify-center rounded-full border border-border bg-background text-sm font-semibold text-foreground sm:size-10",
              dashed && "border-dashed",
            )}
          >
            {marker}
          </span>
        ) : null}
        {last ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -bottom-5 left-1/2 w-px -translate-x-1/2 bg-border",
              marker != null ? "top-9 sm:top-10" : "top-0",
            )}
          />
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function StepSection({
  marker,
  id,
  anchor,
  title,
  subtitle,
  headerRight,
  last,
  children,
}: {
  marker?: ReactNode;
  id: string;
  anchor?: string;
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-case-step-anchor={anchor}>
      <StepRail marker={marker} last={last}>
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-3 flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h2
                id={id}
                tabIndex={-1}
                className="text-lg font-semibold leading-7 text-card-foreground outline-none"
              >
                {title}
              </h2>
              {subtitle ? (
                <p className="text-sm text-muted-foreground">{subtitle}</p>
              ) : null}
            </div>
            {headerRight ? (
              <div className="-mr-1.5 flex shrink-0 items-center">
                {headerRight}
              </div>
            ) : null}
          </div>
          <div>{children}</div>
        </div>
      </StepRail>
    </section>
  );
}

/** One compact line that opens into the product's field editor. */
export function StepRow({
  anchor,
  Icon,
  iconClass,
  label,
  value,
  extra,
  missing,
  chips,
  menu,
  open,
  onToggle,
  children,
}: {
  anchor: string;
  Icon: LucideIcon;
  iconClass: string;
  label: string;
  value?: string;
  extra?: string;
  missing?: string;
  chips?: ReactNode;
  menu?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <li
      data-case-step-anchor={anchor}
      className={cn(
        "rounded-lg border bg-card",
        open ? "border-ring/60 shadow-xs" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5 pl-2.5 pr-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          data-case-step-toggle={anchor}
          className="flex min-w-0 flex-1 basis-56 items-center gap-2 py-1 text-left"
        >
          <Icon className={cn("size-4 shrink-0", iconClass)} aria-hidden />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium leading-5 text-card-foreground">
              {label}
              {value || missing ? ":" : ""}
            </span>
            {value ? (
              <code className="max-w-full truncate rounded-md border border-border bg-muted/60 px-1.5 py-px font-mono text-xs leading-5 text-card-foreground">
                {value}
              </code>
            ) : missing ? (
              <span className="text-xs text-destructive">{missing}</span>
            ) : null}
            {extra ? (
              <span className="text-xs text-muted-foreground">{extra}</span>
            ) : null}
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {chips}
          {menu}
        </div>
      </div>
      {/* Mounted while closed, so an invalid draft inside still blocks Save. */}
      <div hidden={!open} className="border-t border-border px-3 py-3 sm:px-4">
        {children}
      </div>
    </li>
  );
}
