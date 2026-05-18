import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { usePostHog } from "posthog-js/react";
import { useHostList } from "@/hooks/useClients";
import { useConvexAuth } from "convex/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

export type ClientPickerLocation =
  | "chat_tab"
  | "chatbox_builder"
  | "eval_runner"
  | "project_settings";

interface HostPickerProps {
  projectId: string | null;
  value: string | null;
  onChange: (hostId: string | null) => void;
  location: ClientPickerLocation;
  placeholder?: string;
  includeNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}

export function ClientPicker({
  projectId,
  value,
  onChange,
  location,
  placeholder = "Select a host",
  includeNone = true,
  noneLabel = "Project default",
  disabled = false,
}: HostPickerProps) {
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });

  const selectValue =
    value !== null ? value : includeNone ? "__none__" : undefined;

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => {
        const next = v === "__none__" ? null : v;
        if (next !== null) {
          posthog.capture("client_selected", {
            location,
            platform: detectPlatform(),
            environment: detectEnvironment(),
            client_id: next,
          });
        }
        onChange(next);
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
        {hosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {host.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
