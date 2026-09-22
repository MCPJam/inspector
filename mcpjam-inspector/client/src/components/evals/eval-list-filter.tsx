import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import { cn } from "@mcpjam/design-system/cn";
import { runHistoryFilterClass } from "./run-history-table";

export const ALL_EVAL_FILTER_VALUES = "__all__";

export const evalListFilterHeaderClass =
  "h-auto max-w-full gap-1 rounded-sm border-0 bg-transparent px-0 py-0 text-xs font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-ring dark:bg-transparent dark:hover:bg-transparent data-[size=sm]:h-auto";

export type EvalListFilterLabel =
  | "Client"
  | "Model"
  | "Server"
  | "Repository"
  | "Branch"
  | "Status";

function allOptionLabel(label: EvalListFilterLabel) {
  if (label === "Repository") return "All repositories";
  if (label === "Branch") return "All branches";
  if (label === "Status") return "All statuses";
  return `All ${label.toLowerCase()}s`;
}

export function EvalListFilter({
  label,
  value,
  options,
  onChange,
  disabled = false,
  variant = "chip",
  className,
  formatOption,
}: {
  label: EvalListFilterLabel;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** `header` is a ghost trigger that matches a muted column label. */
  variant?: "chip" | "header";
  className?: string;
  formatOption?: (option: string) => string;
}) {
  const display = (option: string) => formatOption?.(option) ?? option;
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={cn(
          variant === "header"
            ? evalListFilterHeaderClass
            : runHistoryFilterClass,
          className,
        )}
      >
        <span className="truncate">
          {value === ALL_EVAL_FILTER_VALUES ? label : display(value)}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_EVAL_FILTER_VALUES}>
          {allOptionLabel(label)}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {display(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
