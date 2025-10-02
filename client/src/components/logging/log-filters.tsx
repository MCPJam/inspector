import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogLevelBadge } from "./log-level-badge";
import { useMemo, useState } from "react";
import { LogLevel } from "@/hooks/use-logger";
import { ColumnFiltersState } from "@tanstack/react-table";
import { LOG_LEVELS, LOG_CONTEXTS } from "@/hooks/use-logger";
import { Badge } from "@/components/ui/badge";
import LogDatePicker from "./log-date-picker";
import { useAppState } from "@/hooks/use-app-state";

interface LogFiltersProps {
  filters: ColumnFiltersState;
  onFilterUpdate: (id: string, value: string) => void;
}

const LogFilters = ({ filters, onFilterUpdate }: LogFiltersProps) => {
  const {
    appState: { servers },
  } = useAppState();

  const searchQuery = useMemo(
    () => (filters.find((f) => f.id === "message")?.value as string) || "",
    [filters],
  );

  const logLevel = useMemo(
    () => (filters.find((f) => f.id === "level")?.value as string) || "all",
    [filters],
  );

  const logContext = useMemo(
    () => (filters.find((f) => f.id === "context")?.value as string) || "all",
    [filters],
  );

  const timestamp = useMemo(
    () => filters.find((f) => f.id === "timestamp")?.value as string,
    [filters],
  );

  const server = useMemo(
    () => (filters.find((f) => f.id === "server")?.value as string) || "all",
    [filters],
  );

  const timestamps = JSON.parse(timestamp);

  const [openFrom, setOpenFrom] = useState(false);
  const [openTo, setOpenTo] = useState(false);

  const onDateChange = (key: string, date: Date) => {
    const previous = new Date(timestamps[key]);

    date.setHours(Number(previous.getHours()));
    date.setMinutes(Number(previous.getMinutes()));
    date.setSeconds(Number(previous.getSeconds()));

    onFilterUpdate(
      "timestamp",
      JSON.stringify({
        to: timestamps["to"],
        from: timestamps["from"],
        [key]: date.getTime(),
      }),
    );
  };

  const onTimeChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    key: string,
  ) => {
    const updated = new Date(timestamps[key]);

    const value = e.target.value;
    const [hours, minutes, seconds] = value.split(":");

    updated.setHours(Number(hours));
    updated.setMinutes(Number(minutes));
    updated.setSeconds(Number(seconds));

    onFilterUpdate(
      "timestamp",
      JSON.stringify({
        to: timestamps["to"],
        from: timestamps["from"],
        [key]: updated.getTime(),
      }),
    );
  };

  return (
    <div className="flex items-center gap-2 flex-1">
      <Select
        value={server}
        onValueChange={(value) =>
          onFilterUpdate("server", value === "all" ? "" : value)
        }
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Servers</SelectItem>
          <SelectItem value="Unknown">Unknown</SelectItem>
          {Object.keys(servers).map((server) => (
            <SelectItem key={server} value={server}>
              {server}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
          {Object.keys(LOG_LEVELS).map((level) => (
            <SelectItem key={level} value={level}>
              <LogLevelBadge level={level as LogLevel} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={logContext}
        onValueChange={(value) =>
          onFilterUpdate("context", value === "all" ? "" : value)
        }
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Contexts</SelectItem>
          {LOG_CONTEXTS.map((context) => (
            <SelectItem key={context} value={context}>
              <Badge variant="secondary">{context}</Badge>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        placeholder="Search logs..."
        value={searchQuery}
        onChange={(e) => onFilterUpdate("message", e.target.value)}
        className="h-8"
      />

      <div className="flex items-center gap-2">
        <LogDatePicker
          open={openFrom}
          setOpen={setOpenFrom}
          date={new Date(timestamps["from"])}
          onDateChange={(value: Date) => onDateChange("from", value)}
          onTimeChange={(e) => onTimeChange(e, "from")}
        />
        to
        <LogDatePicker
          open={openTo}
          setOpen={setOpenTo}
          date={new Date(timestamps["to"])}
          onDateChange={(value: Date) => onDateChange("to", value)}
          onTimeChange={(e) => onTimeChange(e, "to")}
        />
      </div>
    </div>
  );
};

export default LogFilters;
