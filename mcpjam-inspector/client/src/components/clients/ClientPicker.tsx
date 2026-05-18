import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useHostList } from "@/hooks/useHosts";
import { useConvexAuth } from "convex/react";

interface HostPickerProps {
  projectId: string | null;
  value: string | null;
  onChange: (hostId: string | null) => void;
  placeholder?: string;
  includeNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}

export function HostPicker({
  projectId,
  value,
  onChange,
  placeholder = "Select a host",
  includeNone = true,
  noneLabel = "Project default",
  disabled = false,
}: HostPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });

  const selectValue =
    value !== null ? value : includeNone ? "__none__" : undefined;

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => onChange(v === "__none__" ? null : v)}
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
