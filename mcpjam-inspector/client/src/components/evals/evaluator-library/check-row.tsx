import { Switch } from "@mcpjam/design-system/switch";
import { Lock } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RoleChip, RoleSegmentGroup } from "../scorer-role-control";
import type { ScorerUiRole } from "../suite-scorer-table-model";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

type CheckRowBase = {
  label: string;
  role: ScorerUiRole;
  /** Model answers get the info tint so they read apart from assertions. */
  variant?: "assertion" | "model";
};

export type CheckRowConfigProps = CheckRowBase & {
  mode: "config";
  /** What the check looks at, e.g. "From each test case · Partial match". */
  detail?: ReactNode;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  onRoleChange?: (role: ScorerUiRole) => void;
  /** Built-in checks cannot be turned off or re-roled. */
  locked?: boolean;
};

export type CheckRowResultProps = CheckRowBase & {
  mode: "result";
  status: VerdictStatus;
  /** Shown in place of the status word, e.g. "0.62". */
  scoreLabel?: string;
  /** What was observed, never what was expected. */
  evidence?: ReactNode;
};

export type CheckRowProps = CheckRowConfigProps | CheckRowResultProps;

/**
 * One assertion or model question. The same row configures a check and shows
 * its result, so a check looks the same in suite settings, the evaluator
 * detail and the scorecard.
 */
export function CheckRow(props: CheckRowProps) {
  const switchId = useId();
  const failed = props.mode === "result" && props.status === "failed";
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        props.variant === "model" && "bg-info/5",
        failed && "bg-destructive/5",
      )}
    >
      <div className="min-w-0 flex-1">
        {props.mode === "config" && !props.locked && props.onEnabledChange ? (
          <label htmlFor={switchId} className="text-sm text-card-foreground">
            {props.label}
          </label>
        ) : (
          <div className="text-sm text-card-foreground">{props.label}</div>
        )}
        {props.mode === "config" && props.detail ? (
          <div className="text-xs text-muted-foreground">{props.detail}</div>
        ) : null}
        {props.mode === "result" && props.evidence ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {props.evidence}
          </div>
        ) : null}
      </div>
      {props.mode === "config" ? (
        <ConfigControls {...props} switchId={switchId} />
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <RoleChip role={props.role} />
          <VerdictPill
            size="sm"
            status={props.status}
            label={props.scoreLabel}
          />
        </div>
      )}
    </li>
  );
}

function ConfigControls({
  label,
  role,
  enabled = true,
  onEnabledChange,
  onRoleChange,
  locked,
  switchId,
}: CheckRowConfigProps & { switchId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {locked ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Lock aria-hidden className="size-3" />
          Built in
        </span>
      ) : null}
      {onRoleChange && !locked ? (
        <RoleSegmentGroup
          value={role}
          ariaLabel={`${label} role`}
          onChange={onRoleChange}
        />
      ) : (
        <RoleChip role={role} />
      )}
      {onEnabledChange && !locked ? (
        <Switch
          id={switchId}
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      ) : null}
    </div>
  );
}
