import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RoleChip } from "../scorer-role-control";
import type { ScorerUiRole } from "../suite-scorer-table-model";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

export type CheckRowProps = {
  label: string;
  role: ScorerUiRole;
  status: VerdictStatus;
  evidence?: ReactNode;
};

export function CheckRow({ label, role, status, evidence }: CheckRowProps) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        status === "failed" && "bg-destructive/5",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-card-foreground">{label}</div>
        {evidence !== undefined && evidence !== null ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{evidence}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <RoleChip role={role} />
        <VerdictPill size="sm" status={status} />
      </div>
    </li>
  );
}
