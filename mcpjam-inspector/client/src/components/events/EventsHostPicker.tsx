import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { HostListItem } from "@/hooks/useClients";
import { track } from "@/lib/analytics";
import { clientDisplayName } from "@/lib/client-display-name";
import {
  BUILT_IN_EVENTS_HOST_NAME,
  type EventsHostChoice,
} from "./use-events-host";

const BUILT_IN_VALUE = "__built_in__";

/**
 * Which client the tab subscribes as. Hosted: a choice among the project's
 * clients and MCPJam (built-in). Local: a label, because the local runtime
 * reuses the connection the active client opened.
 */
export function EventsHostPicker({
  hosted,
  hosts,
  hostId,
  choice,
  onChange,
}: {
  hosted: boolean;
  hosts: HostListItem[];
  hostId: string | null;
  choice: EventsHostChoice | undefined;
  onChange: (hostId: string | null) => void;
}) {
  if (!hosted) {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        data-testid="events-host-label"
      >
        Receiving as {choice?.name ?? "…"}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="events-host"
        className="text-[11px] text-muted-foreground"
      >
        Receive as
      </label>
      <Select
        value={hostId ?? BUILT_IN_VALUE}
        onValueChange={(value) => {
          const next = value === BUILT_IN_VALUE ? null : value;
          onChange(next);
          try {
            track("client_selected", {
              location: "events_tab",
              client_id: next ?? "built_in",
            });
          } catch {
            // Analytics must never block the selection.
          }
        }}
      >
        <SelectTrigger
          id="events-host"
          aria-label="Events client"
          className="h-7 text-xs"
        >
          <SelectValue placeholder={choice?.name ?? "Loading…"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={BUILT_IN_VALUE}>
            {BUILT_IN_EVENTS_HOST_NAME}
          </SelectItem>
          {hosts.map((host) => (
            <SelectItem key={host.hostId} value={host.hostId}>
              {clientDisplayName(host)}
            </SelectItem>
          ))}
          {choice?.missing && hostId ? (
            <SelectItem value={hostId} disabled>
              {choice.name}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}
