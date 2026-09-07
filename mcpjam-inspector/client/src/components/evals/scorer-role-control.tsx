/**
 * The Gate / Warn / Report control, in one place.
 *
 * Two surfaces author a scorer's role now — the suite's Scorers table and the
 * case page's Scorers list — and they must not drift. The DOM here is exactly
 * what `SuiteScorerTable` shipped with (`role="group"` + `aria-pressed`
 * buttons), because its tests assert against it.
 *
 * ONE DELIBERATE CHANGE from the suite table's original: when the backend does
 * not advertise check policy, the read-only chip shows the AUTHORED role
 * rather than a hard-coded "Gate". A suite file or the CLI can author
 * `role: "advisory"` today; rendering that as "Gate" tells a reader the check
 * will fail their trial when it cannot. Not being able to EDIT a role is not a
 * reason to misreport it.
 */

import React from "react";
import { cn } from "@/lib/utils";
import { STAGE_CHIP_TONE_CLASS } from "@/components/evaluate/stage-chain-model";
import { ROLE_LEGEND, type ScorerUiRole } from "./suite-scorer-table-model";

/** Read-only role, for a row whose role this surface cannot author. */
export function RoleChip({ role }: { role: ScorerUiRole }) {
  return (
    <span
      title={ROLE_LEGEND[role].meaning}
      className={cn(
        "inline-flex rounded-sm border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-[0.06em]",
        role === "gate" ? "text-foreground" : STAGE_CHIP_TONE_CLASS.unmeasured,
      )}
    >
      {ROLE_LEGEND[role].label}
    </span>
  );
}

export function RoleSegment({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "px-2 py-1 text-[10px] uppercase tracking-[0.06em] first:rounded-l-[5px] last:rounded-r-[5px]",
        pressed
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The segmented control. `ariaLabel` names what is being roled ("Check role",
 * "Judge role") so two groups on one page stay distinguishable to a screen
 * reader and to a test.
 */
export function RoleSegmentGroup({
  value,
  roles = ["gate", "warn", "report"],
  disabledRoles,
  ariaLabel,
  onChange,
}: {
  value: ScorerUiRole;
  roles?: readonly ScorerUiRole[];
  disabledRoles?: readonly ScorerUiRole[];
  ariaLabel: string;
  onChange: (role: ScorerUiRole) => void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border/60"
    >
      {roles.map((role) => (
        <RoleSegment
          key={role}
          pressed={value === role}
          disabled={disabledRoles?.includes(role)}
          onClick={() => onChange(role)}
        >
          {ROLE_LEGEND[role].label}
        </RoleSegment>
      ))}
    </div>
  );
}
