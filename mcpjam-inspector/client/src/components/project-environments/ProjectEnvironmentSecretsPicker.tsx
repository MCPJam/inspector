import { useMemo } from "react";
import { AlertTriangle, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { useProjectSecrets } from "@/hooks/useProjectSecrets";
import type { ProjectEnvironmentSecretSelection } from "@/hooks/useProjectEnvironments";

/** Backend cap on `secretSelection.secretIds`. */
export const MAX_ENVIRONMENT_SECRETS = 50;

/**
 * Secret multi-select for a project environment's `secretSelection` — the
 * environment's CREDENTIAL GRANT.
 *
 * ## Personal secrets are selectable, and that is the feature
 *
 * Unlike the skills picker, which refuses personal skills outright, this list
 * includes the editor's OWN personal secrets: pinning one into a shared
 * environment is the motivating personal-secrets workflow — your session gets
 * your key, a teammate's session of the same environment silently does not.
 * The "only your sessions" chip says that at the point of selection, because
 * discovering it from a teammate's failing run is the bad version.
 *
 * Another member's personal secret cannot appear here at all: the backend query
 * does not return it, so there is nothing to filter and nothing to explain.
 *
 * ## Selection is not delivery
 *
 * Membership here means "this environment asks for this secret". Whether a
 * given RUN receives it is re-checked live at launch against that session's
 * owner — which is what lets a member's access be revoked without editing every
 * environment that names their secret.
 *
 * Emits `{ mode: 'explicit', secretIds }` or `null` — never an empty array (the
 * backend rejects `[]`; clearing the grant means `null`).
 */
export function ProjectEnvironmentSecretsPicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  value: ProjectEnvironmentSecretSelection | null | undefined;
  onChange: (next: ProjectEnvironmentSecretSelection | null) => void;
  disabled?: boolean;
}) {
  const secrets = useProjectSecrets(projectId);
  const selectedIds = useMemo(() => new Set(value?.secretIds ?? []), [value]);
  const atCap = selectedIds.size >= MAX_ENVIRONMENT_SECRETS;

  /**
   * Selected ids the list does not return: the secret was deleted, or it is
   * another member's personal one (pinned through the API, where the same
   * visibility rule applies to the EDITOR — so this can only be a leftover).
   *
   * Without a row they would be invisible AND unremovable, yet still shipped on
   * save. They get detach-only rows instead. Gated on the list having loaded so
   * the loading state does not flash every selection as an orphan.
   */
  const orphanIds = useMemo(
    () =>
      secrets === undefined
        ? []
        : Array.from(selectedIds).filter(
            (id) => !secrets.some((secret) => secret.secretId === id),
          ),
    [secrets, selectedIds],
  );

  const emit = (nextIds: Set<string>) => {
    // Never emit an empty explicit selection — clearing the grant means null.
    if (nextIds.size === 0) {
      onChange(null);
      return;
    }
    onChange({ mode: "explicit", secretIds: Array.from(nextIds) });
  };

  const toggle = (secretId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      if (next.size >= MAX_ENVIRONMENT_SECRETS) return;
      next.add(secretId);
    } else {
      next.delete(secretId);
    }
    emit(next);
  };

  if (secrets === undefined) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading secrets…
      </div>
    );
  }

  // Only the truly-empty case short-circuits. With orphaned selections we must
  // fall through so they get detach-only rows — otherwise they are invisible,
  // unremovable, and still sent on save.
  if (secrets.length === 0 && orphanIds.length === 0) {
    return (
      <p className="py-1 text-xs italic text-muted-foreground">
        No secrets in this project yet. Add one in project settings, then select
        it here to grant it to this environment&apos;s runs.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div
        role="group"
        aria-label="Environment secrets"
        className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1"
      >
        {secrets.map((secret) => {
          const checked = selectedIds.has(secret.secretId);
          const capBlocked = !checked && atCap;
          return (
            <Label
              key={secret.secretId}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30",
                (disabled || capBlocked) &&
                  "cursor-not-allowed opacity-60 hover:bg-transparent",
              )}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) =>
                  toggle(secret.secretId, next === true)
                }
                disabled={disabled || capBlocked}
                aria-label={secret.name}
              />
              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs font-normal">
                  {secret.name}
                </span>
                {secret.description ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {secret.description}
                  </span>
                ) : null}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {secret.sharing === "user" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="text-[10px]">
                        only your sessions
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[260px]">
                      <p className="text-xs leading-snug">
                        This is your personal secret. Selecting it here is
                        legal, and it will reach the runs YOU start from this
                        environment — a teammate running the same environment
                        silently does not receive it.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {secret.delivery === "materialized" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <AlertTriangle className="size-2.5" /> in the box
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[260px]">
                      <p className="text-xs leading-snug">
                        Materialized: the value becomes a real environment
                        variable inside the sandbox, so a CLI can read it — and
                        so can anything else the agent runs.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <ShieldCheck className="size-2.5" /> brokered
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[280px]">
                      <p className="text-xs leading-snug">
                        Injected by the egress proxy outside the sandbox, on{" "}
                        {(secret.brokerHosts ?? []).join(", ") ||
                          "its bound hosts"}
                        . The box never holds the value, and a CLI in the box
                        cannot read it.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </span>
            </Label>
          );
        })}

        {orphanIds.map((secretId) => (
          <Label
            key={secretId}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/30"
          >
            <Checkbox
              checked
              onCheckedChange={() => toggle(secretId, false)}
              disabled={disabled}
              aria-label={`Remove missing secret ${secretId}`}
            />
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-xs">{secretId}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                No longer available — deleted, or owned by another member.
                Uncheck to remove it from this environment.
              </span>
            </span>
          </Label>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {selectedIds.size === 0
          ? "No secrets. Runs from this environment receive none."
          : `${selectedIds.size} of ${MAX_ENVIRONMENT_SECRETS} selected.`}
      </p>
    </div>
  );
}
