import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { usePostHog } from "posthog-js/react";
import { useHostList, type HostListItem } from "@/hooks/useClients";
import { useConvexAuth } from "convex/react";
import { standardEventProps } from "@/lib/PosthogUtils";

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
  | "chatbox_builder"
  | "eval_runner"
  | "project_settings";

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
}

export function HostPicker({
  projectId,
  value,
  onChange,
  location,
  placeholder = "Select a host",
  includeNone = true,
  noneLabel = "Project default",
  disabled = false,
  priorityHostId,
}: HostPickerProps) {
  const posthog = usePostHog();
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
            posthog.capture("client_selected", {
              ...standardEventProps(location),
              client_id: next,
            });
          } catch {
            // swallow — analytics must not block the selection
          }
        }
      }}
      disabled={disabled || isLoading}
    >
      <SelectTrigger>
        <SelectValue placeholder={isLoading ? "Loading..." : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeNone && (
          <SelectItem value="__none__">{noneLabel}</SelectItem>
        )}
        {orderedHosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {host.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
