import * as React from "react";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  clearable?: boolean;
  iconClassName?: string;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      value,
      onValueChange,
      placeholder = "Search…",
      className,
      clearable = true,
      iconClassName,
      ...props
    },
    ref,
  ) => {
    return (
      <div className="relative">
        <Search
          className={cn(
            "absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground",
            iconClassName,
          )}
        />
        <Input
          ref={ref}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          type="search"
          role="searchbox"
          aria-label={placeholder}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "pl-7 h-8 bg-background border-border hover:border-border/80 text-xs md:text-xs leading-4 text-foreground placeholder:text-muted-foreground/70",
            className,
          )}
          {...props}
        />
        {clearable && value && (
          <button
            type="button"
            onClick={() => onValueChange("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  },
);

SearchInput.displayName = "SearchInput";

export default SearchInput;
