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

interface LogFiltersProps {
  filters: ColumnFiltersState;
  onFilterUpdate: (id: string, value: string) => void;
}

const LogFilters = ({ filters, onFilterUpdate }: LogFiltersProps) => {
  const searchQuery = useMemo(
    () => (filters.find((f) => f.id === "message")?.value as string) || "",
    [filters]
  );

  const logLevel = useMemo(
    () => (filters.find((f) => f.id === "level")?.value as string) || "all",
    [filters]
  );

  const logContext = useMemo(
    () => (filters.find((f) => f.id === "context")?.value as string) || "all",
    [filters]
  );

  const [openFrom, setOpenFrom] = useState(false);
  const [openTo, setOpenTo] = useState(false);
  const [dateFrom, setDateFrom] = useState(
    new Date(new Date().getTime() - 30 * 60 * 1000)
  );
  const [dateTo, setDateTo] = useState(new Date());

  const onDateChange = (
    value: Date,
    date: Date,
    setDate: (value: Date) => void
  ) => {
    const updated = new Date(value);

    updated.setHours(Number(date.getHours()));
    updated.setMinutes(Number(date.getMinutes()));
    updated.setSeconds(Number(date.getSeconds()));

    setDate(updated);
  };

  const onTimeChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    date: Date,
    setDate: (value: Date) => void
  ) => {
    const updated = new Date(date);

    const value = e.target.value;
    const [hours, minutes, seconds] = value.split(":");

    updated.setHours(Number(hours));
    updated.setMinutes(Number(minutes));
    updated.setSeconds(Number(seconds));

    setDate(updated);
  };

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
          date={dateFrom}
          setDate={setDateFrom}
          onDateChange={(value: Date) =>
            onDateChange(value, dateFrom, setDateFrom)
          }
          onTimeChange={(e) => onTimeChange(e, dateFrom, setDateFrom)}
        />
        to
        <LogDatePicker
          open={openTo}
          setOpen={setOpenTo}
          date={dateTo}
          setDate={setDateTo}
          onDateChange={(value: Date) => onDateChange(value, dateTo, setDateTo)}
          onTimeChange={(e) => onTimeChange(e, dateTo, setDateTo)}
        />
      </div>
    </div>
  );
};

export default LogFilters;
