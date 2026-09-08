import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useHostList, type HostListItem } from "@/hooks/useClients";
import { useConvexAuth } from "convex/react";
import { track } from "@/lib/analytics";
import { clientDisplayName } from "@/lib/client-display-name";

/**
 * Pure: place `priorityHostId` first if it exists in the list. The rest
 * keeps its original order. Exported for unit-testing — Radix Select's
 * dropdown items don't render in JSDOM until the trigger is opened, so
 * driving the integration with `userEvent` for an ordering check is more
 * brittle than just testing the function.
 */
export function orderHostsByPriority(
  hosts: HostListItem[],
  priorityHostId: string | undefined,
): HostListItem[] {
  if (!priorityHostId) return hosts;
  const idx = hosts.findIndex((h) => h.hostId === priorityHostId);
  if (idx <= 0) return hosts;
  const priority = hosts[idx];
  return [priority, ...hosts.slice(0, idx), ...hosts.slice(idx + 1)];
}

export type HostPickerLocation =
  | "chat_tab"
  | "scenario_builder"
  | "eval_runner"
  | "project_settings"
  | "project_environments";

interface HostPickerProps {
  projectId: string | null;
  value: string | null;
  onChange: (hostId: string | null) => void;
  location: HostPickerLocation;
  placeholder?: string;
  includeNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
  /**
   * Optional host ID to float to the top of the dropdown. When unset the
   * options render in the order `useHostList` returns. The leaf does not
   * reach into route/app context — callers pass whatever priority signal
   * makes sense for their surface.
   */
  priorityHostId?: string;
  /**
   * `id` for the select trigger, so a sibling `<Label htmlFor>` names the
   * control. Without it the accessible name is only the selected value or
   * placeholder — "Claude", never "Client".
   */
  triggerId?: string;
  /**
   * Extra classes for the trigger. `SelectTrigger` is `w-fit` by default, so a
   * caller placing this in a grid column has to say `w-full` or the control
   * shrinks to its content while its neighbour fills the cell.
   */
  triggerClassName?: string;
}

export function HostPicker({
  projectId,
  value,
  onChange,
  location,
  placeholder = "Select a client",
  includeNone = true,
  noneLabel = "Project default",
  disabled = false,
  priorityHostId,
  triggerId,
  triggerClassName,
}: HostPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });

  const orderedHosts = useMemo(
    () => orderHostsByPriority(hosts, priorityHostId),
    [hosts, priorityHostId],
  );

  const selectValue =
    value !== null ? value : includeNone ? "__none__" : undefined;

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => {
        const next = v === "__none__" ? null : v;
        onChange(next);
        // Telemetry is best-effort: a posthog throw must not block the
        // user's selection from taking effect.
        if (next !== null) {
          try {
            track("client_selected", {
              location,
              client_id: next,
            });
          } catch {
            // swallow — analytics must not block the selection
          }
        }
      }}
      disabled={disabled || isLoading}
    >
      <SelectTrigger id={triggerId} className={triggerClassName}>
        <SelectValue placeholder={isLoading ? "Loading..." : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeNone && (
          <SelectItem value="__none__">{noneLabel}</SelectItem>
        )}
        {orderedHosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {clientDisplayName(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
