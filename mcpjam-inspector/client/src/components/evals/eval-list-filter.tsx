import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import { cn } from "@mcpjam/design-system/cn";
import { runHistoryFilterClass } from "./run-history-table";

export const ALL_EVAL_FILTER_VALUES = "__all__";

export function EvalListFilter({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  label: "Client" | "Model" | "Server" | "Repository" | "Branch";
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={cn(runHistoryFilterClass, className)}
      >
        <span className="truncate">
          {value === ALL_EVAL_FILTER_VALUES ? label : value}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_EVAL_FILTER_VALUES}>
          {label === "Repository"
            ? "All repositories"
            : label === "Branch"
              ? "All branches"
              : `All ${label.toLowerCase()}s`}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
