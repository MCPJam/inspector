import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogLevelBadge } from "./log-level-badge";
import { useMemo } from "react";
import { LogLevel } from "@/hooks/use-logger";
import { ColumnFiltersState } from "@tanstack/react-table";

const LOG_LEVEL_ORDER = ["error", "warn", "info", "debug", "trace"];

interface LogFiltersProps {
  filters: ColumnFiltersState;
  onFilterUpdate: (id: string, value: string) => void;
}

const LogFilters = ({ filters, onFilterUpdate }: LogFiltersProps) => {
  const searchQuery = useMemo(
    () => (filters.find((f) => f.id === "message")?.value as string) || "",
    [filters],
  );

  const logLevel = useMemo(
    () => (filters.find((f) => f.id === "level")?.value as string) || "all",
    [filters],
  );

  return (
    <div className="flex items-center gap-2 flex-1">
      <Select
        value={logLevel}
        onValueChange={(value) =>
          onFilterUpdate("level", value === "all" ? "" : value)
        }
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Levels</SelectItem>
          {LOG_LEVEL_ORDER.map((level) => (
            <SelectItem key={level} value={level}>
              <LogLevelBadge level={level as LogLevel} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Search className="h-4 w-4" />
      <Input
        placeholder="Search logs..."
        value={searchQuery}
        onChange={(e) => onFilterUpdate("message", e.target.value)}
        className="h-8"
      />
    </div>
  );
};

export default LogFilters;
